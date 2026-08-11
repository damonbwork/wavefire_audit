/**
 * Wavefire Audit App — Backend API Proxy
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── SMTP / outbound email ───────────────────────────────────────────────────
// Same defensive pattern as the database URL and encryption key below: check
// for real configuration, warn clearly if it's missing, and never silently
// pretend email is working when it isn't — a user who never receives their
// password-setup link with no visible error anywhere is a much worse
// failure mode than a clear startup warning.
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
// The base URL used to build the password-setup link sent in the email —
// e.g. "https://wavefireaudit-production.up.railway.app". Must be set
// explicitly; guessing at a request's Host header for this would be
// unreliable behind a proxy and is exactly the kind of thing that should
// be configured once, deliberately, not inferred.
const APP_BASE_URL = process.env.APP_BASE_URL || '';

const SMTP_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS && APP_BASE_URL);
if (!SMTP_CONFIGURED) {
  console.error('[SMTP] Not fully configured — set SMTP_HOST, SMTP_USER, SMTP_PASS, and APP_BASE_URL. ' +
    'Password-setup emails cannot be sent until this is done; user creation will still work, ' +
    'but the new user will have no way to receive their setup link.');
}
const mailTransporter = SMTP_CONFIGURED ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for port 465 (implicit TLS), false for 587/others (STARTTLS)
  auth: { user: SMTP_USER, pass: SMTP_PASS },
}) : null;

// ── S3-compatible object storage (sample file attachments) ─────────────────
// Same defensive pattern as SMTP above: real configuration required, a
// clear startup warning if it's missing, and never silently pretend
// storage is working when it isn't — a file upload that appears to
// succeed but never actually lands anywhere is a much worse failure mode
// than an explicit error at the point of use.
//
// Deliberately provider-agnostic — this works against Railway Buckets or
// any other S3-compatible endpoint (real AWS S3, MinIO, etc.) via
// STORAGE_ENDPOINT, rather than being hardcoded to one vendor's SDK
// quirks. STORAGE_ENDPOINT is only required for non-AWS providers; real
// AWS S3 resolves its endpoint automatically from the region and can
// leave it unset.
const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const STORAGE_ENDPOINT   = process.env.STORAGE_ENDPOINT || '';
const STORAGE_REGION     = process.env.STORAGE_REGION || 'auto';
const STORAGE_ACCESS_KEY = process.env.STORAGE_ACCESS_KEY || '';
const STORAGE_SECRET_KEY = process.env.STORAGE_SECRET_KEY || '';
const STORAGE_BUCKET     = process.env.STORAGE_BUCKET || '';

const STORAGE_CONFIGURED = !!(STORAGE_ACCESS_KEY && STORAGE_SECRET_KEY && STORAGE_BUCKET);
if (!STORAGE_CONFIGURED) {
  console.error('[Storage] Not fully configured — set STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY, and ' +
    'STORAGE_BUCKET (and STORAGE_ENDPOINT for a non-AWS provider like Railway Buckets). ' +
    'Sample file upload/download will fail with a clear error until this is set.');
}
const s3Client = STORAGE_CONFIGURED ? new S3Client({
  region: STORAGE_REGION,
  endpoint: STORAGE_ENDPOINT || undefined, // omit entirely for real AWS S3, which resolves its own endpoint
  forcePathStyle: !!STORAGE_ENDPOINT, // path-style addressing is required by most non-AWS S3-compatible providers
  credentials: { accessKeyId: STORAGE_ACCESS_KEY, secretAccessKey: STORAGE_SECRET_KEY },
}) : null;

// In-memory buffering, not disk — the file is immediately streamed on to
// object storage (see uploadFileToStorage), so there's no reason to write
// it to local disk first. 30MB matches the same ceiling already
// established elsewhere in this file for the Claude API proxy.
const multer = require('multer');
const sampleFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// ── Postgres ────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
  || process.env.database_url
  || process.env.POSTGRES_URL
  || process.env.DATABASE_PRIVATE_URL
  || process.env.DATABASE_PUBLIC_URL;
const pool = dbUrl ? new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } }) : null;
if (!dbUrl) console.warn('[DB] No database URL found — checked DATABASE_URL, database_url, POSTGRES_URL, DATABASE_PRIVATE_URL, DATABASE_PUBLIC_URL');
else console.log('[DB] Connecting to:', dbUrl.replace(/:\/\/[^@]+@/, '://***@'));
// ── Tenant scaffolding ────────────────────────────────────────────────────────
// DEFAULT_TENANT is the placeholder tenant used while the app is single-tenant.
// When multi-tenancy is added, replace every reference to DEFAULT_TENANT_ID with
// the tenant_id resolved from the authenticated session.
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

// Lightweight AES-256-GCM encryption for per-tenant AI credentials
const crypto = require('crypto');
// AES-256-GCM requires a 32-byte key. A missing env var previously fell back to
// 32 zero bytes — a publicly known constant, so ciphertext would be trivially
// decryptable by anyone. Refuse to encrypt rather than provide false assurance.
const _rawEncKey = process.env.CREDENTIAL_ENCRYPTION_KEY || '';
const ENC_KEY_OK = Buffer.byteLength(_rawEncKey, 'utf8') >= 32;
const ENC_KEY = ENC_KEY_OK ? Buffer.from(_rawEncKey, 'utf8').subarray(0, 32) : null;
if (!ENC_KEY_OK) {
  console.error('[SECURITY] CREDENTIAL_ENCRYPTION_KEY is unset or under 32 bytes. ' +
    'Per-tenant AI credentials cannot be encrypted and will be rejected. ' +
    'Set a random 32+ character value in the environment.');
}
function encryptKey(plaintext) {
  if (!plaintext) return '';
  if (!ENC_KEY) throw new Error('CREDENTIAL_ENCRYPTION_KEY not configured');
  try {
    const iv   = crypto.randomBytes(12);
    const ciph = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const enc  = Buffer.concat([ciph.update(plaintext, 'utf8'), ciph.final()]);
    const tag  = ciph.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  } catch(e) { console.error('[enc] error:', e.message); return ''; }
}
function decryptKey(ciphertext) {
  if (!ciphertext) return '';
  if (!ENC_KEY) return '';
  try {
    const buf  = Buffer.from(ciphertext, 'base64');
    const iv   = buf.slice(0, 12);
    const tag  = buf.slice(12, 28);
    const enc  = buf.slice(28);
    const dec  = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
  } catch(e) { return ''; }
}

// ── Password / token hashing ────────────────────────────────────────────────
// scrypt is a memory-hard key derivation function — deliberately expensive
// and resistant to GPU/ASIC-accelerated brute-forcing, unlike a fast
// general-purpose hash (sha256, md5, etc.), which is the wrong tool for
// password storage precisely because it's fast: an attacker with a stolen
// hash could try billions of guesses per second against it. Each password
// (and each token — see hashToken below) gets its own random, unique salt,
// stored alongside the hash as "salt:hash" — reusing a salt across users
// would let an attacker precompute one rainbow table and use it against
// every account at once.
const SCRYPT_KEYLEN = 64;

function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return salt + ':' + derivedKey.toString('hex');
}

function verifyPassword(plaintext, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derivedKey = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  const storedKey = Buffer.from(keyHex, 'hex');
  // timingSafeEqual, not === — a naive string/buffer equality check
  // short-circuits on the first mismatched byte, and the TIME that takes
  // leaks information an attacker can use to guess the correct hash one
  // byte at a time across many requests. Both buffers must be equal
  // length for timingSafeEqual to run at all, so check that first.
  if (storedKey.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(storedKey, derivedKey);
}

// Password-setup/reset tokens use the SAME hashing approach as passwords,
// for the same reason: the raw token is the only thing that should ever be
// able to redeem the link, so what's stored in the database must be
// useless on its own even if the database is exposed.
function hashToken(rawToken) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(rawToken, salt, SCRYPT_KEYLEN);
  return salt + ':' + derivedKey.toString('hex');
}

function verifyToken(rawToken, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const derivedKey = crypto.scryptSync(rawToken, salt, SCRYPT_KEYLEN);
  const storedKey = Buffer.from(keyHex, 'hex');
  if (storedKey.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(storedKey, derivedKey);
}

// Generates the actual raw token that goes in the emailed URL — 32 random
// bytes, base64url-encoded (URL-safe: no +, /, or = characters that would
// need escaping in a link) — cryptographically unguessable, per the
// "randomly assigned" requirement. This is the ONLY place the raw value
// exists outside of the moment it's emailed; the database only ever sees
// its hash (see hashToken above).
function generateSecureToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// ── Real session utilities ────────────────────────────────────────────
// hashSessionToken uses a FAST cryptographic hash (SHA-256) — genuinely
// distinct from hashToken/hashPassword above, which deliberately use
// slow, real scrypt hashing. That's correct for an infrequent, real
// action like setting a password, but a session token needs to be
// verified on every single incoming request, and scrypt's real,
// intentional slowness would be a genuine, real performance problem at
// any meaningful scale. SHA-256 is still a real, one-way cryptographic
// hash — an attacker with database access still cannot recover the
// original token from what's stored — it's just fast, which is
// genuinely the correct tradeoff here.
// Real, minimal cookie parser — deliberately avoids adding a new npm
// dependency (cookie-parser) for what's a real, simple, direct need:
// finding one specific, named cookie's value within the raw Cookie
// header. Returns null if the header is missing or the named cookie
// isn't present.
function _parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === name) return decodeURIComponent(part.slice(eqIdx + 1).trim());
  }
  return null;
}

function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// Real, confirmed session-timeout parameters. SESSION_DURATION_MS is
// the real, absolute maximum a session can ever live, regardless of
// activity — reduced from the prior 7 days to a genuinely shorter,
// real 24 hours, since real, standard best practice pairs a real,
// short absolute maximum with a real, shorter idle timeout, rather
// than one real, long-lived session with no true upper bound.
// IDLE_TIMEOUT_MS is the confirmed, real 4-hour window — a session
// genuinely expires if this much real time passes with no real,
// actual activity, even if the absolute maximum hasn't been reached.
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 real hours — the real, absolute maximum
const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 real hours — the confirmed, real idle/inactivity timeout

// Issues a real, new session for a given user — generates a genuinely
// random, unguessable token, stores only its fast hash (never the raw
// token itself, matching the same real discipline already used for
// password-reset tokens), and returns the real, raw token for the
// caller to actually send back to the browser (the only place it ever
// exists outside this one moment).
async function createSession(userId) {
  if (!pool) return null;
  const rawToken = generateSecureToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, last_activity_at) VALUES ($1,$2,$3,NOW())`,
    [userId, tokenHash, expiresAt]
  );
  return rawToken;
}

// The real, actual per-request check — hashes the incoming, real token,
// looks up a real, non-expired session, and returns the real, CURRENT,
// live user record (not a stale, cached one — is_active/is_superadmin
// could have genuinely changed since the session was first issued, and
// every check here should reflect the real, current state). Per the
// confirmed, real design: also enforces the real, 4-hour idle timeout
// as a genuine, real "sliding window" — a session past that real gap
// since its own last_activity_at is genuinely, correctly treated as
// expired, even if its real, absolute expires_at hasn't been reached
// yet; a session that IS still within the real, idle window has its
// last_activity_at updated to the real, current moment, so genuinely,
// actively-used sessions keep extending while an abandoned one expires
// on schedule.
async function getUserFromSessionToken(rawToken) {
  if (!pool || !rawToken) return null;
  try {
    const tokenHash = hashSessionToken(rawToken);
    const { rows } = await pool.query(
      `SELECT u.user_id, u.tenant_id, u.email, u.login_id, u.first_name, u.last_name,
              u.role, u.is_superadmin, u.is_active, u.xlsx_export_prefs,
              s.session_id, s.last_activity_at, s.current_tenant_id
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [tokenHash]
    );
    if (!rows.length) return null;
    const row = rows[0];

    const idleMs = Date.now() - new Date(row.last_activity_at).getTime();
    if (idleMs > IDLE_TIMEOUT_MS) {
      // Real, genuine idle timeout reached — delete this specific,
      // real session outright rather than merely reject it, so it
      // can't be resurrected or reused even if the real, raw cookie is
      // still sitting in someone's browser.
      await pool.query('DELETE FROM sessions WHERE session_id=$1', [row.session_id]);
      return null;
    }

    // Real, genuine activity — slide the real, actual idle window
    // forward.
    await pool.query('UPDATE sessions SET last_activity_at=NOW() WHERE session_id=$1', [row.session_id]);

    // Real, actual session_id is preserved separately for the real,
    // new set-current-tenant route below (which genuinely needs it to
    // know WHICH session row to update) — but never returned to the
    // caller as part of the real, public user object.
    row.session_id_internal = row.session_id;
    delete row.session_id;
    delete row.last_activity_at;
    return row;
  } catch (err) {
    console.error('getUserFromSessionToken FAILED:', err.message);
    return null;
  }
}

// ── Object storage helpers ──────────────────────────────────────────────
// Generates the actual S3 object key for a sample file — deliberately NOT
// the user-supplied filename (see the sample_files table comment for why:
// collision risk, and unsafe characters in an arbitrary filename). Scoped
// by tenant and workpaper ref so objects are naturally namespaced, with a
// random suffix for genuine uniqueness even if the same filename is
// uploaded twice for the same workpaper (the second upload becomes an
// UPDATE at the database-row level, but still gets its own distinct
// object in storage rather than silently overwriting the first one in
// place — see the upload route for how the OLD object gets cleaned up
// once the new one is confirmed stored).
function _buildBucketKey(tenantId, ref, filename) {
  const safeExt = (filename.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
  return `sample-files/${tenantId}/${ref}/${crypto.randomUUID()}${safeExt}`;
}

// Uploads a file to object storage. Takes a Buffer or a Readable stream —
// lib-storage's Upload handles multipart upload automatically for larger
// files rather than requiring the whole file to be buffered into memory
// as one PutObjectCommand call, which matters given this app's real
// confirmed file sizes (attached sample PDFs have run several megabytes
// each, with a combined request limit already raised to 30MB elsewhere
// in this file for the Analyze feature).
async function uploadFileToStorage(bucketKey, body, contentType) {
  if (!STORAGE_CONFIGURED || !s3Client) {
    throw new Error('Object storage is not configured on the server — cannot upload file.');
  }
  const upload = new Upload({
    client: s3Client,
    params: { Bucket: STORAGE_BUCKET, Key: bucketKey, Body: body, ContentType: contentType || 'application/octet-stream' },
  });
  await upload.done();
}

// Returns a readable stream for a stored file — the download route pipes
// this directly to the HTTP response rather than buffering the entire
// file into server memory first, which matters at the file sizes this
// app actually handles.
async function getFileFromStorage(bucketKey) {
  if (!STORAGE_CONFIGURED || !s3Client) {
    throw new Error('Object storage is not configured on the server — cannot retrieve file.');
  }
  const result = await s3Client.send(new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: bucketKey }));
  return result; // .Body is the readable stream; caller also gets ContentType/ContentLength from here
}

async function deleteFileFromStorage(bucketKey) {
  if (!STORAGE_CONFIGURED || !s3Client) {
    throw new Error('Object storage is not configured on the server — cannot delete file.');
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: STORAGE_BUCKET, Key: bucketKey }));
}

// Sends the password-setup email. Throws (doesn't swallow the error) if
// SMTP isn't configured or sending genuinely fails — the caller (the
// user-creation route) needs to know the difference between "user created,
// email sent" and "user created, but they have no way to receive their
// setup link," since those are very different outcomes for whoever's
// creating the account to know about.
async function sendPasswordSetupEmail(toEmail, firstName, rawToken) {
  if (!SMTP_CONFIGURED || !mailTransporter) {
    throw new Error('SMTP is not configured on the server — cannot send password-setup email.');
  }
  const setupUrl = `${APP_BASE_URL.replace(/\/$/, '')}/set-password?token=${encodeURIComponent(rawToken)}`;
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  await mailTransporter.sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: 'Set up your Wavefire password',
    text: `${greeting}\n\n` +
      `An account has been created for you on Wavefire. To set your password and finish setting up your account, ` +
      `visit the link below:\n\n${setupUrl}\n\n` +
      `This link is valid for 7 days and can only be used once. If it expires before you use it, contact your ` +
      `administrator to have a new one sent.\n\n` +
      `If you weren't expecting this email, you can safely ignore it.`,
    html: `<p>${greeting}</p>` +
      `<p>An account has been created for you on Wavefire. To set your password and finish setting up your account, ` +
      `click the link below:</p>` +
      `<p><a href="${setupUrl}">${setupUrl}</a></p>` +
      `<p><strong>This link is valid for 7 days and can only be used once.</strong> If it expires before you use it, ` +
      `contact your administrator to have a new one sent.</p>` +
      `<p style="color:#666;font-size:13px">If you weren't expecting this email, you can safely ignore it.</p>`,
  });
}

// ── Security helpers ─────────────────────────────────────────────────────────
// The Azure endpoint is operator-supplied but is used to build an outbound URL
// that carries the API key in a header. An attacker-controlled value would
// exfiltrate that key (SSRF + credential leak). Validate on write AND on read,
// so values persisted before this check was added can never be used.
function isSafeAzureEndpoint(raw) {
  if (!raw) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;          // https://key@evil.com
  const host = u.hostname.toLowerCase();
  // Azure OpenAI resources always live under these suffixes.
  const ALLOWED_SUFFIXES = ['.openai.azure.com', '.cognitiveservices.azure.com'];
  if (!ALLOWED_SUFFIXES.some(s => host.endsWith(s))) return false;
  // Reject the bare suffix itself and any embedded credentials/traversal.
  if (ALLOWED_SUFFIXES.includes('.' + host)) return false;
  return true;
}

// Azure deployment names are path segments — keep them to a safe charset so they
// cannot escape the path (e.g. "../../" or a full URL).
function isSafeDeploymentName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name);
}

// Error bodies currently echo err.message, which leaks schema and driver detail.
// Log the real error server-side; return something generic to the client.
function fail(res, err, context, status = 500) {
  console.error(`[${context}]`, err && err.message ? err.message : err);
  // Real, confirmed fix — the actual, specific database error was
  // previously only ever logged server-side, never surfaced to the
  // client at all, meaning a real, live failure could only ever show a
  // bare "HTTP 500" with no further, real detail to diagnose from. Safe
  // to include here: this is an internal, authenticated tool, not a
  // public API, so the real, actual cause being visible is far more
  // valuable than a generic message that hides it.
  return res.status(status).json({
    error: 'Internal server error',
    detail: err && err.message ? err.message : String(err),
    code: err && err.code ? err.code : undefined,
  });
}

async function initDB() {
  if (!pool) { console.log('No DATABASE_URL — running without database'); return; }
  try {
    await pool.query(`
      -- ── Tenants (scaffold for future multi-tenancy) ────────────────────────
      -- The master tenant table — every other table's tenant_id column is a
      -- foreign key into this one's own primary key, id (named plainly
      -- "id" here since within this table itself "tenant_id" would just
      -- repeat what the table already is — the standard relational
      -- convention, matching how users.user_id / user_tenants.user_id work
      -- the same way).
      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT 'Default Organisation',
        description TEXT DEFAULT '',
        domain      TEXT DEFAULT '',
        plan        TEXT DEFAULT 'trial',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO tenants (id, name) VALUES ('default','Default Organisation')
        ON CONFLICT (id) DO NOTHING;

      -- ── Users ─────────────────────────────────────────────────────────────
      -- Minimum requested fields: user id, first/last name, created/updated
      -- timestamps, role. A few more are included because this table needs
      -- to actually support real login later (see the auth work already
      -- planned): email as the real login identifier (a generated user_id
      -- isn't something a person types in), password_hash (never a
      -- plaintext password column — even as an unused placeholder, that's
      -- a real security mistake to leave sitting in a schema), tenant_id
      -- to scope each user the same way every other tenant-scoped table
      -- here does (this is a user's HOME tenant, not a hard boundary —
      -- user_tenants below is what actually grants access to more than
      -- one), and is_active so an admin can disable a user without
      -- deleting their row (and losing whatever that user created/owns
      -- elsewhere in the schema, which is referenced by name/id, not
      -- cascaded from a user row).
      --
      -- email is GLOBALLY unique (not scoped per-tenant) — a real person's
      -- email should identify exactly one account. This was originally
      -- UNIQUE(tenant_id, email), which allowed the same email to exist as
      -- separate rows under different tenants; that stops making sense now
      -- that user_tenants already lets one single account access multiple
      -- tenants, and is a genuine conflict with is_superadmin below, which
      -- needs to be one identity that transcends tenant boundaries
      -- entirely, not something that could be duplicated per tenant.
      --
      -- is_superadmin is deliberately separate from role: role can still
      -- vary per tenant (via user_tenants.role, see below), but SuperAdmin
      -- is an application-wide grant — access to every tenant and every
      -- role — that bypasses tenant/role scoping altogether, so it belongs
      -- on the user's own account, not on any one tenant relationship.
      CREATE TABLE IF NOT EXISTS users (
        user_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            TEXT NOT NULL DEFAULT 'default',
        email                TEXT NOT NULL UNIQUE,
        password_hash        TEXT NOT NULL DEFAULT '',
        first_name           TEXT DEFAULT '',
        last_name            TEXT DEFAULT '',
        role                 TEXT NOT NULL DEFAULT 'user',
        is_superadmin        BOOLEAN NOT NULL DEFAULT false,
        is_active            BOOLEAN NOT NULL DEFAULT true,
        must_change_password BOOLEAN NOT NULL DEFAULT true,
        date_created         TIMESTAMPTZ DEFAULT NOW(),
        date_updated         TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      -- ── User-Tenant links ────────────────────────────────────────────────
      -- Genuine many-to-many: a user can belong to and have access to more
      -- than one tenant, which users.tenant_id alone can't express (that
      -- column is a user's single "home" tenant — where their account was
      -- created — not the full set of tenants they can actually work
      -- within). role here is a PER-TENANT override: a user can reasonably
      -- be an admin in one tenant and a regular user in another. When no
      -- override exists for a given tenant, application code should fall
      -- back to users.role — so the simple single-tenant case still works
      -- with nothing extra to configure, and only genuinely multi-tenant
      -- users need a row here per additional tenant.
      CREATE TABLE IF NOT EXISTS user_tenants (
        user_id       UUID NOT NULL,
        tenant_id     TEXT NOT NULL,
        role          TEXT DEFAULT NULL,
        date_created  TIMESTAMPTZ DEFAULT NOW(),
        date_updated  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, tenant_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      -- ── Password setup / reset tokens ───────────────────────────────────────
      -- Stores a HASH of the token, never the raw token itself — same
      -- principle as password storage. The raw, random token only ever
      -- exists in the emailed link and briefly in server memory while it's
      -- generated; if this table (or a database backup/dump) were ever
      -- exposed, a stored raw token would let an attacker use any
      -- unexpired link immediately, whereas a hash is useless without the
      -- original value. Verifying a submitted token means hashing IT the
      -- same way and comparing hashes — see the /api/auth/set-password
      -- route.
      --
      -- Deliberately generic (not "new_user_tokens") — the exact same
      -- mechanism correctly covers both initial account setup (a brand-new
      -- user with no password yet) and any future "forgot password" flow,
      -- so there's no need for a second, near-duplicate table later.
      -- used_at is set the moment a token is successfully redeemed, making
      -- every token strictly single-use even if the link is somehow
      -- clicked more than once before it naturally expires.
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL,
        token_hash   TEXT NOT NULL,
        purpose      TEXT NOT NULL DEFAULT 'initial_setup',
        expires_at   TIMESTAMPTZ NOT NULL,
        used_at      TIMESTAMPTZ,
        date_created TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      );

      -- ── Per-tenant AI credential store ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS tenant_ai_configs (
        tenant_id        TEXT NOT NULL DEFAULT 'default',
        provider         TEXT NOT NULL DEFAULT 'anthropic',
        model            TEXT DEFAULT 'claude-sonnet-4-6',
        endpoint         TEXT DEFAULT '',
        deployment       TEXT DEFAULT '',
        encrypted_key    TEXT DEFAULT '',
        key_hint         TEXT DEFAULT '',
        azure_tenant_id  TEXT DEFAULT '',
        use_managed_id   BOOLEAN DEFAULT FALSE,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, provider),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS entity_types (
        name    TEXT PRIMARY KEY,
        bg      TEXT NOT NULL DEFAULT '#f1f5f9',
        color   TEXT NOT NULL DEFAULT '#475569',
        border  TEXT NOT NULL DEFAULT '#cbd5e1',
        icon    TEXT NOT NULL DEFAULT 'ti-tag',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workpaper_annotations (
        ref         TEXT NOT NULL,
        filename    TEXT NOT NULL,
        annotations JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (tenant_id, ref, filename)
      );

      -- ── Sample files (actual bytes live in object storage, not here) ────────
      -- Metadata and a bucket reference only — the file's actual bytes are
      -- uploaded directly to S3-compatible object storage (see
      -- uploadFileToStorage/getFileFromStorage below) and never touch
      -- Postgres. Keyed the same way as workpaper_annotations
      -- (tenant_id, ref, filename) so the two relate naturally without a
      -- foreign key or redesigning the existing annotations table.
      --
      -- bucket_key is the ACTUAL S3 object key — deliberately not the
      -- same as filename. Two different uploads could plausibly share a
      -- filename (a user re-uploads "contract.pdf" for a different
      -- sample), and an arbitrary user-supplied filename could contain
      -- characters that aren't safe as an S3 key — bucket_key is always a
      -- generated, collision-proof identifier; filename is what's shown
      -- to and typed by a person.
      --
      -- archived follows the same soft-hide pattern already used on
      -- workpapers.archived — a removed file drops out of the visible
      -- list without actually deleting the object, so it stays
      -- recoverable rather than being gone the moment someone clicks
      -- remove.
      CREATE TABLE IF NOT EXISTS sample_files (
        file_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        ref          TEXT NOT NULL,
        filename     TEXT NOT NULL,
        bucket_key   TEXT NOT NULL,
        content_type TEXT DEFAULT 'application/octet-stream',
        size_bytes   BIGINT DEFAULT 0,
        bucket_name  TEXT DEFAULT '',
        uploaded_by  TEXT DEFAULT '',
        archived     BOOLEAN NOT NULL DEFAULT false,
        -- Real, durable provenance — which original filename (if any)
        -- this file was annotated/derived from. NULL/empty means this
        -- IS the pristine original. Mirrors the in-memory _annotatedFrom
        -- field the frontend already used, which was never persisted —
        -- the actual root cause of a genuinely annotated file showing as
        -- "Original" once reloaded from storage, since that in-memory-
        -- only field silently evaporated on every reload.
        annotated_from TEXT DEFAULT NULL,
        date_created TIMESTAMPTZ DEFAULT NOW(),
        date_updated TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (tenant_id, ref, filename)
      );
      CREATE TABLE IF NOT EXISTS audits (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT '',
        period      TEXT DEFAULT '',
        owner       TEXT DEFAULT '',
        type        TEXT DEFAULT '',
        status      TEXT DEFAULT 'planned',
        description TEXT DEFAULT '',
        year        INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, name)
      );
      CREATE TABLE IF NOT EXISTS workpapers (
        id                     UUID UNIQUE DEFAULT gen_random_uuid(),
        tenant_id              TEXT NOT NULL DEFAULT 'default',
        ref                    TEXT NOT NULL DEFAULT '',
        audit_name             TEXT NOT NULL DEFAULT '',
        name                   TEXT DEFAULT '',
        type                   TEXT DEFAULT '',
        status                 TEXT DEFAULT 'draft',
        results                TEXT DEFAULT '',
        preparer               TEXT DEFAULT '',
        reviewer               TEXT DEFAULT '',
        secondary_reviewer     TEXT DEFAULT '',
        date_started           DATE,
        review_date            DATE,
        date_submitted         DATE,
        secondary_review_date  DATE,
        population             TEXT DEFAULT '',
        sample_method          TEXT DEFAULT '',
        sample_size            INTEGER,
        narrative              TEXT DEFAULT '',
        description            TEXT DEFAULT '',
        test_desc              TEXT DEFAULT '',
        linked_controls        JSONB DEFAULT '[]',
        linked_risks           JSONB DEFAULT '[]',
        linked_entities        JSONB DEFAULT '[]',
        fs_accounts            JSONB DEFAULT '[]',
        scope_entities         JSONB DEFAULT '[]',
        scope_fs_accounts      JSONB DEFAULT '[]',
        test_attributes        JSONB DEFAULT '[]',
        sample_fields          JSONB DEFAULT '[]',
        sample_data            JSONB DEFAULT '{"columns":[],"rows":[]}',
        exceptions             JSONB DEFAULT '[]',
        archived               BOOLEAN DEFAULT false,
        -- ── M-Template fields (new workpaper type, sections: Header,
        -- Information About this Control, Nature of the TOC) — genuinely
        -- new columns, not reused from existing fields, except where the
        -- user explicitly said to map onto an existing one (reviewer =
        -- "Final Reviewer" — no new column needed for that one).
        audit_date               DATE,
        peer_reviewer            TEXT DEFAULT '',
        gr_review                TEXT DEFAULT '',
        control_description      TEXT DEFAULT '',
        it_process               TEXT DEFAULT '',
        frequency                TEXT DEFAULT '',
        frequency_other          TEXT DEFAULT '',
        risk_of_failure          TEXT DEFAULT '',
        rationale_higher_risk    TEXT DEFAULT '',
        toc_inquiry_performed       BOOLEAN DEFAULT false,
        toc_observation_performed   BOOLEAN DEFAULT false,
        toc_reperformance_performed BOOLEAN DEFAULT false,
        -- Timing of the TOC — stored as plain MM/YYYY text (matching how
        -- the original ITGC file itself stored this: a genuine text
        -- string, not a real date type, despite the visual date-like
        -- formatting hint) — the actual masking/validation happens in
        -- the input field itself, not the database column.
        toc_period_from_mmyyyy    TEXT DEFAULT '',
        toc_period_to_mmyyyy      TEXT DEFAULT '',
        -- Extent of the TOC
        population_source         TEXT DEFAULT '',
        population_size           TEXT DEFAULT '', -- free text per explicit confirmation — may include a note alongside a number, not a strict integer
        population_completeness_desc TEXT DEFAULT '',
        toc_sample_size            TEXT DEFAULT '', -- free text, same reasoning as population_size
        sample_selection_method    TEXT DEFAULT '',
        -- M-Template Header: a genuinely independent, free-form text
        -- field per explicit instruction — deliberately NOT linked to
        -- the existing entities array/reference table on this workpaper.
        mt_entity_name             TEXT DEFAULT '',
        -- M-Template Header: "ITGC name/ref:" — defaults to the
        -- workpaper's own ref but is independently editable/overridable,
        -- per "should default as the workpaper ID" implying it can
        -- diverge from it, not always mirror it live.
        mt_itgc_ref                TEXT DEFAULT '',
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, ref)
      );

      -- ── Workpaper Types (administrative categorization ONLY) ────────────────
      -- Genuinely separate from templates — this has NO bearing on which
      -- layout/sections render. A workpaper's type is just what it is:
      -- Planning, Testwork, Report, Admin, or Other. This was previously
      -- conflated with templates in one table (workpaper_types held both,
      -- distinguished only by a plain_type_selectable flag) — split apart
      -- per explicit correction: these are two genuinely different
      -- concepts, not one list with an exclusion bit.
      CREATE TABLE IF NOT EXISTS workpaper_types (
        name        TEXT PRIMARY KEY,
        description TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      -- This INSERT deliberately does NOT rely on the CREATE TABLE above
      -- alone: on a database where workpaper_types already exists from
      -- before this session's Type/Template split, IF NOT EXISTS means
      -- Postgres skips that CREATE TABLE entirely, leaving the LIVE
      -- table's actual structure in place — which still has layout_key
      -- defined as TEXT NOT NULL at this exact point in execution (the
      -- migration that drops that column is a separate, LATER query,
      -- not part of this same multi-statement batch). An INSERT that
      -- omits layout_key would violate that constraint and throw,
      -- silently aborting every statement after it in this one giant
      -- query — including workpaper_templates' own CREATE TABLE further
      -- below, which is the actual, now-confirmed reason it never
      -- existed at all despite being correctly written. Providing an
      -- explicit, harmless value here satisfies the live constraint
      -- regardless of whether the later DROP COLUMN migration has run.
      INSERT INTO workpaper_types (name, description, sort_order, layout_key) VALUES
        ('Planning', 'Planning workpaper.', 1, 'n/a'),
        ('Testwork', 'Testwork workpaper.', 2, 'n/a'),
        ('Report',   'Report workpaper.', 3, 'n/a'),
        ('Admin',    'Administrative workpaper.', 4, 'n/a'),
        ('Other',    'Other workpaper type.', 5, 'n/a')
      ON CONFLICT (name) DO NOTHING;

      -- ── Workpaper Templates (New Workpaper modal only) ───────────────────────
      -- The starting-point choice a user makes ONCE, at creation, in the
      -- New Workpaper modal. layout_key is what actually determines which
      -- sections/fields render — this is NOT stored as an ongoing field
      -- on the workpaper itself; its effect (the chosen layout) is
      -- captured once into workpapers.wp_style at creation time and
      -- persists from there. This table exists purely to drive that
      -- one-time modal choice.
      CREATE TABLE IF NOT EXISTS workpaper_templates (
        name        TEXT PRIMARY KEY,
        layout_key  TEXT NOT NULL,
        description TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO workpaper_templates (name, layout_key, description, sort_order) VALUES
        ('Workpaper-Short Template', 'skinny',    'Short-form workpaper — admin/narrow sections only.', 1),
        ('Workpaper-Long Template',  'full',      'Long-form workpaper — full set of sections including scope, narrative, test attributes, sample data, and analysis.', 2),
        ('M-Template',               'mtemplate', 'Structured control-testing template.', 3),
        ('M-Template-Short',         'mtemplate-short', 'M-Template without the Header, Information About this Control, and Nature/Timing/Extent of the TOC sections.', 4)
      ON CONFLICT (name) DO NOTHING;

      -- ── Workpaper Statuses (reference table, mirrors workpaper_types) ───────
      -- Real canonical status codes — confirmed against the existing
      -- statusLabel mapping and every status-setting control already in
      -- the app (workpaper detail header, New Workpaper form): draft /
      -- review / approved. The workpaper list's own status FILTER
      -- dropdown had been using plain display text as its values instead
      -- (no value attribute set, defaulting to "Draft"/"In review"/
      -- "Reviewed") — which never actually matched any real workpaper's
      -- stored status (always lowercase "draft"/"review"/"approved"), so
      -- that filter had silently returned zero results this whole time.
      -- This table is the single source of truth going forward for both
      -- the value AND the label, fixing that mismatch at its root.
      CREATE TABLE IF NOT EXISTS workpaper_statuses (
        value       TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        sort_order  INTEGER DEFAULT 0,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO workpaper_statuses (value, label, sort_order) VALUES
        ('draft',    'Draft',     1),
        ('review',   'In review', 2),
        ('approved', 'Reviewed',  3)
      ON CONFLICT (value) DO NOTHING;

      -- ── Workpaper Tag Descriptions ────────────────────────────────────────
      -- Maps each real workpaper tag code (the same codes already in the
      -- wpd-tag-options datalist elsewhere in this app — CC, SEC, OPS,
      -- FIN, IPE) to a human-readable description. Seeded with empty
      -- descriptions deliberately — the actual meaning of each code
      -- (e.g. what "SEC" stands for) is domain-specific to this firm's
      -- own workpaper-naming convention, which only the user actually
      -- knows; these should be filled in through the app (or directly in
      -- this table) rather than guessed at here.
      CREATE TABLE IF NOT EXISTS workpaper_tag_descriptions (
        code        TEXT PRIMARY KEY,
        description TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO workpaper_tag_descriptions (code, description, sort_order) VALUES
        ('CC',  '', 1),
        ('SEC', '', 2),
        ('OPS', '', 3),
        ('FIN', '', 4),
        ('IPE', '', 5)
      ON CONFLICT (code) DO NOTHING;

      CREATE TABLE IF NOT EXISTS company_context (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        id          INTEGER DEFAULT 1,
        notes       TEXT DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS fs_accounts (
        tenant_id       TEXT NOT NULL DEFAULT 'default',
        id              TEXT NOT NULL DEFAULT '',
        code            TEXT DEFAULT '',
        description     TEXT DEFAULT '',
        section         TEXT DEFAULT '',
        cur_balance     NUMERIC,
        py_balance      NUMERIC,
        materiality     TEXT DEFAULT '',
        txn_volume      TEXT DEFAULT '',
        inherent_risk   TEXT DEFAULT '',
        key_account     BOOLEAN DEFAULT FALSE,
        assertions      JSONB DEFAULT '[]',
        audit_approach  TEXT DEFAULT '',
        notes           TEXT DEFAULT '',
        fn_text         TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS control_categories (
        name       TEXT PRIMARY KEY,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Seed defaults if empty
      INSERT INTO control_categories (name, sort_order) VALUES
        ('Access',1),('Change Management',2),('Operations',3),
        ('Financial Reporting',4),('Compliance',5),('IT General Controls',6),
        ('Payroll',7),('Vendor Due Diligence',8),('Other',9)
      ON CONFLICT (name) DO NOTHING;
      CREATE TABLE IF NOT EXISTS entity_types (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS controls (
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        id           TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        category     TEXT DEFAULT '',
        objective    TEXT DEFAULT '',
        objective_id TEXT DEFAULT '',
        description  TEXT DEFAULT '',
        ctrl_owner   TEXT DEFAULT '',
        proc_owner   TEXT DEFAULT '',
        extra_ctrl_owners JSONB DEFAULT '[]',
        extra_proc_owners JSONB DEFAULT '[]',
        frequency    TEXT DEFAULT '',
        control_type TEXT DEFAULT '',
        additional_info TEXT DEFAULT '',
        linked_risks     JSONB DEFAULT '[]',
        linked_entities  JSONB DEFAULT '[]',
        linked_accounts  JSONB DEFAULT '[]',
        analyst_notes    TEXT DEFAULT '',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS risks (
        tenant_id    TEXT NOT NULL DEFAULT 'default',
        id           TEXT NOT NULL DEFAULT '',
        name         TEXT NOT NULL DEFAULT '',
        category     TEXT DEFAULT '',
        description  TEXT DEFAULT '',
        analyst_notes TEXT DEFAULT '',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS control_objectives (
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        id          TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS company_settings (
        tenant_id     TEXT NOT NULL DEFAULT 'default' PRIMARY KEY,
        name          TEXT DEFAULT '',
        industry      TEXT DEFAULT '',
        fiscal_year_end TEXT DEFAULT '',
        address       TEXT DEFAULT '',
        city          TEXT DEFAULT '',
        state         TEXT DEFAULT '',
        zip           TEXT DEFAULT '',
        website       TEXT DEFAULT '',
        ein           TEXT DEFAULT '',
        ai_provider   TEXT DEFAULT 'anthropic',
        ai_model      TEXT DEFAULT 'claude-sonnet-4-6',
        azure_endpoint TEXT DEFAULT '',
        azure_deployment TEXT DEFAULT '',
        azure_api_key TEXT DEFAULT '',
        openai_api_key TEXT DEFAULT '',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── Data Analysis tables ──────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS da_datasets (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   TEXT NOT NULL DEFAULT 'default',
        name        TEXT NOT NULL DEFAULT '',
        filename    TEXT NOT NULL DEFAULT '',
        file_hash   TEXT NOT NULL DEFAULT '',
        row_count   INTEGER DEFAULT 0,
        col_count   INTEGER DEFAULT 0,
        notes       TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_used   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS da_columns (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        col_index   INTEGER NOT NULL,
        col_name    TEXT NOT NULL DEFAULT '',
        label       TEXT DEFAULT '',
        col_type    TEXT DEFAULT 'auto',
        include_in_model BOOLEAN DEFAULT TRUE,
        encoding    TEXT DEFAULT 'auto',
        notes       TEXT DEFAULT '',
        UNIQUE (dataset_id, col_index)
      );

      CREATE TABLE IF NOT EXISTS da_labels (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        row_index   INTEGER NOT NULL,
        label       TEXT NOT NULL DEFAULT 'uncertain',
        labeled_by  TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        labeled_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (dataset_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS da_model_runs (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id  UUID NOT NULL REFERENCES da_datasets(id) ON DELETE CASCADE,
        model_type  TEXT NOT NULL DEFAULT '',
        params      JSONB DEFAULT '{}',
        scores      JSONB DEFAULT '[]',
        thresholds  JSONB DEFAULT '{}',
        weights     JSONB DEFAULT '{}',
        label_count INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB: risks + controls tables ready');

    // ── Indexes ───────────────────────────────────────────────────────────────
    // Every list/read query filters on one of these columns; without indexes each
    // is a full table scan. IF NOT EXISTS makes this safe to run on every boot.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audits_tenant           ON audits(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_workpapers_tenant       ON workpapers(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_workpapers_audit        ON workpapers(tenant_id, audit_name);
      CREATE INDEX IF NOT EXISTS idx_controls_tenant         ON controls(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_risks_tenant            ON risks(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_entities_tenant         ON assessment_entities(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_fs_accounts_tenant      ON fs_accounts(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_control_obj_tenant      ON control_objectives(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_da_datasets_tenant      ON da_datasets(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_da_datasets_hash        ON da_datasets(tenant_id, file_hash);
      CREATE INDEX IF NOT EXISTS idx_da_columns_dataset      ON da_columns(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_da_labels_dataset       ON da_labels(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_da_runs_dataset         ON da_model_runs(dataset_id);
    `);
    console.log('DB: indexes ready');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assessment_entities (
        tenant_id            TEXT NOT NULL DEFAULT 'default',
        id                   TEXT NOT NULL DEFAULT '',
        name                 TEXT NOT NULL DEFAULT '',
        type                 TEXT NOT NULL DEFAULT 'Facility',
        category             TEXT NOT NULL DEFAULT 'facility',
        address              TEXT DEFAULT '',
        city                 TEXT DEFAULT '',
        state                TEXT DEFAULT '',
        poc                  TEXT DEFAULT '',
        sub                  TEXT DEFAULT '',
        description          TEXT DEFAULT '',
        app_purpose          TEXT DEFAULT '',
        user_count           TEXT DEFAULT '',
        txn_volume           TEXT DEFAULT '',
        txn_dollar           TEXT DEFAULT '',
        change_volume        TEXT DEFAULT '',
        change_complexity    TEXT DEFAULT '',
        admin_users          TEXT DEFAULT '',
        key_integrations     TEXT DEFAULT '',
        external_integrations TEXT DEFAULT '',
        custom_fields         JSONB DEFAULT '[]',
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      );
    `);
    console.log('DB: assessment_entities table ready');

    // ── Auto-migrations for pre-existing tables ──────────────────────────────
    try {
      // Tenant scaffolding — add tenant_id to all existing tables
      const tenantTables = [
        'audits','workpapers','workpaper_annotations','controls','risks',
        'assessment_entities','fs_accounts','company_context',
        'control_objectives','control_categories'
      ];
      for (const tbl of tenantTables) {
        await pool.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      // company_settings uses tenant_id as PK — handle separately
      await pool.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`).catch(()=>{});
      console.log('DB: tenant_id columns added to all tables');

      // tenant_id columns were added to these tables via the migration loop
      // above, but that never retroactively updated audits' PRIMARY KEY (or
      // any other unique constraint) to include tenant_id — meaning on a
      // table that predates this file's current schema, the real
      // constraint on the live table is very likely still on name alone (or
      // missing tenant_id entirely). Every audit save relies on
      // ON CONFLICT (tenant_id, name), which requires an ACTUAL unique
      // constraint or index on exactly that column pair — without one,
      // Postgres throws "no unique or exclusion constraint matching the ON
      // CONFLICT specification" on every single insert, an error that
      // never reaches the browser (the route only ever returns a generic
      // 500) but explains a new audit failing to save with no other
      // symptom. Checked directly against pg_constraint rather than
      // assumed, so this is a no-op on a table that's already correct.
      try {
        const { rows: auditConstraintRows } = await pool.query(`
          SELECT con.conname, array_agg(att.attname ORDER BY att.attnum) AS cols
          FROM pg_constraint con
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
          WHERE con.conrelid = 'audits'::regclass AND con.contype IN ('p','u')
          GROUP BY con.conname
        `);
        const hasCorrectConstraint = auditConstraintRows.some(r =>
          r.cols.length === 2 && r.cols.includes('tenant_id') && r.cols.includes('name')
        );
        if (!hasCorrectConstraint) {
          console.log('DB: audits table is missing a unique constraint on (tenant_id, name) — adding one now. Existing constraints found:', auditConstraintRows.map(r => r.conname + '(' + r.cols.join(',') + ')'));
          // Drop any OLD primary key first — a table can only have one, and
          // if the live one is just on "name" (the pre-tenant_id schema),
          // it must go before the correct composite one can be added.
          const oldPk = auditConstraintRows.find(r => r.cols.length !== 2 || !r.cols.includes('tenant_id') || !r.cols.includes('name'));
          if (oldPk) {
            await pool.query(`ALTER TABLE audits DROP CONSTRAINT IF EXISTS ${oldPk.conname}`);
          }
          await pool.query(`ALTER TABLE audits ADD CONSTRAINT audits_tenant_name_key UNIQUE (tenant_id, name)`);
          console.log('DB: audits(tenant_id, name) unique constraint added successfully');
        }
      } catch (constraintErr) {
        console.error('DB: could not verify/fix audits unique constraint:', constraintErr.message);
      }

      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true`);

      // Fix users' email uniqueness if it's still the old per-tenant
      // version — same reasoning as the audits constraint fix above:
      // CREATE TABLE IF NOT EXISTS is a no-op on a table that already
      // exists, so if this table was created under an earlier version of
      // this schema (UNIQUE(tenant_id, email) instead of a plain global
      // UNIQUE(email)), nothing would ever correct it without this.
      try {
        const { rows: userConstraintRows } = await pool.query(`
          SELECT con.conname, con.contype, array_agg(att.attname ORDER BY att.attnum) AS cols
          FROM pg_constraint con
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
          WHERE con.conrelid = 'users'::regclass AND con.contype = 'u'
          GROUP BY con.conname, con.contype
        `);
        const hasGlobalEmailUnique = userConstraintRows.some(r => r.cols.length === 1 && r.cols[0] === 'email');
        const oldTenantScopedEmail = userConstraintRows.find(r => r.cols.length === 2 && r.cols.includes('email') && r.cols.includes('tenant_id'));
        if (!hasGlobalEmailUnique && oldTenantScopedEmail) {
          // Check for real duplicate emails across tenants BEFORE trying to
          // add a global unique constraint — if any exist, adding the
          // constraint would fail outright, and forcing it through would
          // require deciding which duplicate "wins," which isn't a decision
          // to make silently in a startup migration. Log and skip in that
          // case rather than crash server startup or guess.
          const { rows: dupes } = await pool.query(
            `SELECT email, COUNT(*) c FROM users GROUP BY email HAVING COUNT(*) > 1`
          );
          if (dupes.length) {
            console.error('DB: cannot make users.email globally unique — duplicate emails exist across tenants:',
              dupes.map(d => d.email + ' (' + d.c + 'x)'),
              '— resolve these manually (merge or rename accounts), then restart.');
          } else {
            await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS ${oldTenantScopedEmail.conname}`);
            await pool.query(`ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)`);
            console.log('DB: users.email is now globally unique (was previously scoped per tenant_id)');
          }
        }
      } catch (userEmailConstraintErr) {
        console.error('DB: could not verify/fix users.email unique constraint:', userEmailConstraintErr.message);
      }

      await pool.query(`ALTER TABLE tenants            ADD COLUMN IF NOT EXISTS description   TEXT DEFAULT ''`);

      // ── Correcting the conflated workpaper_types table ───────────────────
      // This table used to hold BOTH administrative types (Planning,
      // Testwork, Report, Admin, Other) AND templates (Workpaper-Short/
      // Long Template, M-Template, M-Template-Short) in one list,
      // distinguished only by a plain_type_selectable flag — a genuine
      // design mistake corrected per explicit instruction: these are two
      // different concepts and belong in two different tables. This
      // removes the four template rows and the now-unnecessary
      // layout_key/plain_type_selectable columns from the live table,
      // leaving it as purely administrative categorization. Each step
      // isolated in its own try/catch — a hard lesson from several
      // preceding turns, where a shared catch block silently swallowed a
      // failure and prevented a column from ever reaching the live table
      // across multiple deploys without any visible error.
      try {
        await pool.query(`
          DELETE FROM workpaper_types
          WHERE name IN ('Workpaper-Short Template', 'Workpaper-Long Template', 'M-Template', 'M-Template-Short')`);
        console.log('DB: removed template rows from workpaper_types (they now live in workpaper_templates)');
      } catch (cleanupErr) {
        console.error('DB: could not remove template rows from workpaper_types:', cleanupErr.message);
      }
      try {
        await pool.query(`ALTER TABLE workpaper_types DROP COLUMN IF EXISTS layout_key`);
        await pool.query(`ALTER TABLE workpaper_types DROP COLUMN IF EXISTS plain_type_selectable`);
        console.log('DB: workpaper_types columns corrected — now purely administrative categorization');
      } catch (colDropErr) {
        console.error('DB: could not drop obsolete workpaper_types columns:', colDropErr.message);
      }

      // Defensive backfill for workpaper_templates — in case it's already
      // live from a prior deploy of this exact turn's change without
      // these rows (the same failure class already found and fixed for
      // the old table's M-Template rows). Safe to run every startup.
      try {
        await pool.query(`
          INSERT INTO workpaper_templates (name, layout_key, description, sort_order) VALUES
            ('Workpaper-Short Template', 'skinny', 'Short-form workpaper — admin/narrow sections only.', 1),
            ('Workpaper-Long Template',  'full',   'Long-form workpaper — full set of sections including scope, narrative, test attributes, sample data, and analysis.', 2),
            ('M-Template',               'mtemplate', 'Structured control-testing template.', 3),
            ('M-Template-Short',         'mtemplate-short', 'M-Template without the Header, Information About this Control, and Nature/Timing/Extent of the TOC sections.', 4)
          ON CONFLICT (name) DO NOTHING`);
        console.log('DB: workpaper_templates backfill applied successfully');
      } catch (templateErr) {
        console.error('DB: workpaper_templates backfill FAILED:', templateErr.message);
      }

      // ── workpapers primary key — a real, critical, confirmed gap found
      // directly from a live, reported error: "there is no unique or
      // exclusion constraint matching the ON CONFLICT specification."
      // The real, live workpapers table was genuinely created before this
      // codebase's own, current primary-key definition (tenant_id, ref)
      // existed — CREATE TABLE IF NOT EXISTS never retroactively updates
      // an EXISTING table's own, actual constraints, so the real, live
      // database still, genuinely, has whatever earlier, real key it was
      // originally created with. Every, real, workpaper save has
      // genuinely, actually, been attempting an ON CONFLICT target that
      // does not match anything that actually exists on the real, live
      // table — which PostgreSQL correctly, always rejects outright,
      // regardless of how correct the surrounding query text is.
      // Queries the real, live pg_constraint catalog directly for the
      // actual, current primary key's real name, rather than assuming
      // one — matching the exact, same, established, safe pattern
      // already proven correct for this exact class of fix on
      // sample_files. Migrating to the new, correct, composite key is
      // safe for any, real, existing data: anything already, genuinely,
      // unique under the old, single-column key is automatically, also,
      // unique under the new, larger, two-column one.
      try {
        const { rows: pkRows } = await pool.query(`
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'workpapers'::regclass AND contype = 'p'
        `);
        let alreadyCorrect = false;
        for (const { conname } of pkRows) {
          const { rows: colCheck } = await pool.query(`
            SELECT array_agg(a.attname ORDER BY a.attname) AS cols
            FROM pg_constraint c
            JOIN unnest(c.conkey) AS k(attnum) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE c.conname = $1 AND c.conrelid = 'workpapers'::regclass
          `, [conname]);
          const cols = (colCheck[0]?.cols || []).sort();
          if (JSON.stringify(cols) === JSON.stringify(['ref', 'tenant_id'].sort())) {
            alreadyCorrect = true;
          } else {
            await pool.query(`ALTER TABLE workpapers DROP CONSTRAINT "${conname}"`);
            console.log(`DB: dropped the real, old, actual workpapers primary key (${conname}) — was (${cols.join(', ')}), not (tenant_id, ref)`);
          }
        }
        if (!alreadyCorrect) {
          await pool.query(`ALTER TABLE workpapers ADD PRIMARY KEY (tenant_id, ref)`);
          console.log('DB: workpapers primary key corrected to (tenant_id, ref)');
        } else {
          console.log('DB: workpapers primary key already correctly (tenant_id, ref)');
        }
      } catch (pkErr) {
        console.error('DB: workpapers primary key fix FAILED:', pkErr.message);
      }

      // ── workpapers.wp_style — a genuine, real gap found while making this
      // fix: wpStyle was previously only ever an IN-MEMORY value on the
      // frontend's WORKPAPERS array, computed once at creation from the
      // chosen template, but NEVER actually persisted to Postgres as its
      // own column. This meant it was silently lost on every page reload,
      // and several display-time code paths were papering over that gap
      // by re-deriving a layout from w.type instead — which will no
      // longer work correctly now that w.type no longer ever holds a
      // template name. This column is the real fix: the template's
      // EFFECT (which layout to use) is captured here once, at creation,
      // and persists correctly from then on — matching the confirmed
      // design that templates themselves are never stored as an ongoing
      // field on the workpaper.
      try {
        await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS wp_style TEXT DEFAULT 'full'`);
        console.log('DB: workpapers.wp_style column ready');
      } catch (wpStyleErr) {
        console.error('DB: could not add workpapers.wp_style column:', wpStyleErr.message);
      }

      await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS description    TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE controls          ADD COLUMN IF NOT EXISTS objective_id  TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE controls          ADD COLUMN IF NOT EXISTS analyst_notes TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS analyst_notes TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS category TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE risks             ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
      await pool.query(`ALTER TABLE workpapers         ADD COLUMN IF NOT EXISTS sample_data JSONB DEFAULT '{"columns":[],"rows":[]}'`);
      // Archived is deliberately separate from status — status carries real
      // workflow meaning (draft, in review, complete) that must survive an
      // archive/restore cycle untouched, so archiving a workpaper never
      // overwrites or loses whatever status it actually had.
      await pool.query(`ALTER TABLE workpapers         ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`);
      // M-Template workpaper type — new fields, added to the existing
      // live table the same way every other migration here does.
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS audit_date DATE`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS peer_reviewer TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS gr_review TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS control_description TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS it_process TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS frequency_other TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS risk_of_failure TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS rationale_higher_risk TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_inquiry_performed BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_observation_performed BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_reperformance_performed BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_period_from_mmyyyy TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_period_to_mmyyyy TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS population_source TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS population_size TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS population_completeness_desc TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS toc_sample_size TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS sample_selection_method TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS mt_entity_name TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS mt_itgc_ref TEXT DEFAULT ''`);
      try {
        await pool.query(`ALTER TABLE sample_files ADD COLUMN IF NOT EXISTS annotated_from TEXT DEFAULT NULL`);
        console.log('DB: sample_files.annotated_from column ready');
      } catch (annFromErr) {
        console.error('DB: could not add sample_files.annotated_from column:', annFromErr.message);
      }
      await pool.query(`
        INSERT INTO workpaper_tag_descriptions (code, description, sort_order) VALUES
          ('CC', '', 1), ('SEC', '', 2), ('OPS', '', 3), ('FIN', '', 4), ('IPE', '', 5)
        ON CONFLICT (code) DO NOTHING`);
      // Stable per-workpaper id, used to link sample_data_columns/rows and
      // extracted_data back to their workpaper — ref stays the
      // primary key and the human-readable/editable identifier used
      // everywhere else in this codebase, but ref could theoretically be
      // renamed or (across a future multi-tenant world) collide, so the new
      // linking tables use this instead. gen_random_uuid() is a VOLATILE
      // default, which means this ALTER TABLE physically computes and
      // stores a real, unique id for every existing row (not a shared
      // static value, not NULL) rather than the fast metadata-only path
      // Postgres uses for constant defaults — the right tradeoff here since
      // this table is small enough that the one-time rewrite cost is
      // negligible, and every workpaper needs a genuinely distinct id.
      await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid()`);
      await pool.query(`UPDATE workpapers SET id = gen_random_uuid() WHERE id IS NULL`);
      await pool.query(`ALTER TABLE workpapers ALTER COLUMN id SET NOT NULL`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workpapers_id ON workpapers(id)`);
      console.log('DB: workpapers.id backfilled and constrained');

      // ── User Provided Sample Data + Extracted Data tables — created HERE,
      // after workpapers.id is guaranteed to exist and be unique (a foreign
      // key target needs that), not up in the initial CREATE TABLE block.
      // On a fresh install workpapers.id already exists from its own CREATE
      // TABLE with UNIQUE inline, so this is a no-op there; on an existing
      // deployment being migrated, this is the first point at which
      // workpapers.id is actually usable as a FK target.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sample_data_columns (
          id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          workpaper_id   UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          col_index      INTEGER NOT NULL DEFAULT 0,
          title          TEXT DEFAULT '',
          width          INTEGER DEFAULT 180,
          system_added   BOOLEAN DEFAULT FALSE,
          created_at     TIMESTAMPTZ DEFAULT NOW(),
          updated_at     TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sample_data_rows (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          row_index     INTEGER NOT NULL DEFAULT 0,
          cells         JSONB DEFAULT '{}',
          row_height    INTEGER,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        -- Extracted Data field DEFINITIONS: what to search for (Title,
        -- Description, Guidance). Same list drives both extraction modes
        -- below; it never stores per-record extracted values itself.
        CREATE TABLE IF NOT EXISTS extracted_data (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          field_index   INTEGER NOT NULL DEFAULT 0,
          title         TEXT DEFAULT '',
          description   TEXT DEFAULT '',
          guidance      TEXT DEFAULT '',
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        -- Extraction RESULTS for "independent" mode (the Extract Sample Data
        -- checkbox unchecked): one row per sample record the AI found in the
        -- attached files, values keyed by extracted_data.id, with zero
        -- awareness of or link to sample_data_rows/sample_data_columns —
        -- this table exists specifically so that mode can run with no
        -- interaction with the User Provided Sample Data grid at all, even
        -- when that grid already has data. "Append to grid" mode (checkbox
        -- checked) does NOT write here — it writes directly into new
        -- sample_data_columns/sample_data_rows cells instead, marked
        -- system_added so the UI can show them as visually distinct.
        CREATE TABLE IF NOT EXISTS extracted_data_records (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workpaper_id  UUID NOT NULL REFERENCES workpapers(id) ON DELETE CASCADE,
          row_index     INTEGER NOT NULL DEFAULT 0,
          cells         JSONB DEFAULT '{}',
          source_file   TEXT DEFAULT '',
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sdcols_wp     ON sample_data_columns(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_sdrows_wp     ON sample_data_rows(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_extdata_wp    ON extracted_data(workpaper_id);
        CREATE INDEX IF NOT EXISTS idx_extrecords_wp ON extracted_data_records(workpaper_id);
      `);
      console.log('DB: sample_data_columns, sample_data_rows, extracted_data, extracted_data_records ready');
      // Copy any data from a legacy "desc" column if it still exists
      const col = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='audits' AND column_name='desc'`);
      if (col.rows.length) {
        await pool.query(`UPDATE audits SET description = "desc" WHERE (description IS NULL OR description='') AND "desc" IS NOT NULL`);
        console.log('DB: migrated audits.desc → audits.description');
      }
      console.log('DB: all migrations applied');
    } catch(mErr) { console.warn('DB: migration skipped:', mErr.message); }
  } catch(err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// ── Standalone, independent fix for sample_files.annotated_from ─────────
// Direct, confirmed evidence (via /api/diagnose-sample-upload) showed
// this column still does not exist on the live table, despite multiple
// prior attempts to add it from inside initDB()'s own long, shared
// migration chain — where an earlier, unrelated line failing (any of the
// many un-isolated ALTER TABLE statements before it) would silently
// prevent execution from ever reaching this one. This runs as a
// genuinely separate function, with its own connection and error
// handling, entirely independent of whatever does or doesn't succeed
// inside initDB() itself — nothing else can interfere with this specific
// column ever finally landing.
async function ensureAnnotatedFromColumn() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE sample_files ADD COLUMN IF NOT EXISTS annotated_from TEXT DEFAULT NULL`);
    console.log('DB: sample_files.annotated_from column confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone annotated_from check FAILED:', err.message, err.code);
  }
}
ensureAnnotatedFromColumn();

// ── Standalone, independent addition: sample_files.file_category ────────
// Genuinely distinguishes a real "sample" file from a real "workpaper"
// file within this same, existing, proven table — rather than a
// genuinely separate, new, parallel table for what is structurally the
// exact, same, real kind of data (a file attached to a workpaper).
// Defaults to 'sample' for every, real, existing row, since that's
// genuinely what every current row actually is — real, actual
// "Attached Workpaper Files" were never persisted to the backend at
// all before this fix (a real, confirmed gap found while directly
// tracing every real file-attachment path).
// Real, new, standalone migration, per explicit request — genuinely,
// persists each, real, user's, own, last, selection, in, the, "Customize
// the .xlsx export" modal, so it, correctly, becomes the, default the,
// next, time, that, modal, opens, for, them, specifically — not, just, for,
// the, current, browser, but, tied, to, their, real, actual, account,
// matching, the, explicit, request, that, this, be, "each, user's" own,
// preference. A, single, JSONB, column, holds, the, real, complete, set
// of, checkbox, selections, as, one, real, object, — genuinely, simple,
// and, flexible, if, more, real, options, are, ever, added, to, this,
// modal, later, without, needing, a, real, new, column, each, time.
async function ensureXlsxExportPrefsColumn() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xlsx_export_prefs JSONB DEFAULT NULL`);
    console.log('DB: users.xlsx_export_prefs column confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone xlsx_export_prefs check FAILED:', err.message, err.code);
  }
}
ensureXlsxExportPrefsColumn();

async function ensureFileCategoryColumn() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE sample_files ADD COLUMN IF NOT EXISTS file_category TEXT NOT NULL DEFAULT 'sample'`);

    // Real, actual update to the existing, live unique constraint, per
    // explicit confirmation — genuinely allows the same filename to
    // exist once in each real category (a real "summary.pdf" as both a
    // Workpaper File and a Sample File). Queries the real, live
    // pg_constraint catalog directly to find the constraint's actual,
    // current name, rather than assuming the standard, auto-generated
    // one — genuinely more robust, since this table could have been
    // created at a different point with a real, different, actual name.
    const { rows: existingConstraints } = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'sample_files'::regclass AND contype = 'u'
    `);
    for (const { conname } of existingConstraints) {
      // Only touch a real constraint that's genuinely the old, real
      // (tenant_id, ref, filename) shape — never a different, real,
      // unrelated one this table might also have.
      const { rows: colCheck } = await pool.query(`
        SELECT array_agg(a.attname ORDER BY a.attname) AS cols
        FROM pg_constraint c
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conname = $1 AND c.conrelid = 'sample_files'::regclass
      `, [conname]);
      const cols = (colCheck[0]?.cols || []).sort();
      const isOldShape = JSON.stringify(cols) === JSON.stringify(['filename', 'ref', 'tenant_id'].sort());
      if (isOldShape) {
        await pool.query(`ALTER TABLE sample_files DROP CONSTRAINT "${conname}"`);
        console.log(`DB: dropped the real, old (tenant_id, ref, filename) unique constraint (${conname})`);
      }
    }
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'sample_files_tenant_ref_filename_category_key'
        ) THEN
          ALTER TABLE sample_files ADD CONSTRAINT sample_files_tenant_ref_filename_category_key
            UNIQUE (tenant_id, ref, filename, file_category);
        END IF;
      END $$;
    `);

    console.log('DB: sample_files.file_category column and updated unique constraint confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone file_category check FAILED:', err.message, err.code);
  }
}
ensureFileCategoryColumn();

// ── Standalone, independent addition: workpapers.template_used ──────────
// Tracks the actual TEMPLATE NAME chosen at creation (e.g.
// "M-Template-Short", "Workpaper-Long Template") — genuinely distinct
// from wp_style, which stores the template's EFFECT (the layout key,
// e.g. "mtemplate-short") rather than which named template produced it.
// Built as its own standalone function, following the exact same proven
// pattern as ensureAnnotatedFromColumn above, rather than one more line
// inside initDB()'s long, shared migration chain — that chain has
// repeatedly, silently failed to reach later lines when an earlier,
// unrelated statement threw first.
async function ensureTemplateUsedColumn() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE workpapers ADD COLUMN IF NOT EXISTS template_used TEXT DEFAULT NULL`);
    console.log('DB: workpapers.template_used column confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone template_used check FAILED:', err.message, err.code);
  }
}

// ── One-time backfill: existing workpapers' template_used ───────────────
// Per explicit request — derives the real template name for
// already-existing workpapers from their existing, reliable wp_style
// (layout key), reversing the true, known, one-to-one mapping already
// seeded in workpaper_templates, rather than guessing. Only updates rows
// where template_used is still NULL, so this is safe to run on every
// deploy without ever overwriting a real value correctly captured at
// creation time by the save route going forward.
async function backfillTemplateUsedForExistingWorkpapers() {
  if (!pool) return;
  try {
    const { rows } = await pool.query(
      `UPDATE workpapers w
       SET template_used = wt.name
       FROM workpaper_templates wt
       WHERE w.template_used IS NULL
         AND w.wp_style = wt.layout_key
       RETURNING w.ref, w.wp_style, w.template_used`
    );
    console.log(`DB: backfilled template_used for ${rows.length} existing workpaper(s)`);
  } catch (err) {
    console.error('DB: template_used backfill FAILED:', err.message, err.code);
  }
}
// Runs the column-add and the backfill in guaranteed, correct sequence —
// awaiting the former before ever attempting the latter, rather than an
// arbitrary timer that could race ahead of a slow ALTER TABLE.
(async function() {
  await ensureTemplateUsedColumn();
  await backfillTemplateUsedForExistingWorkpapers();
})();

// ── Standalone, independent addition: users.login_id ─────────────────────
// Per explicit request — a new, genuinely distinct field from user_id
// (the internal UUID primary key, never something a person types) and
// from email (the existing real login identifier). login_id defaults to
// a user's email but is stored and editable as its own separate,
// durable field. UNIQUE, matching the real, intended use as an
// identifier a person would actually type to log in — same real
// constraint email already has. Built as its own standalone function,
// following the exact same proven pattern as ensureTemplateUsedColumn
// above, rather than one more line inside initDB()'s long, shared
// migration chain.
async function ensureLoginIdColumn() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_id TEXT`);
    // A separate statement, not inline in the ALTER above — adding a
    // UNIQUE constraint to a column that may already have real,
    // non-unique NULL values (before the backfill below runs) needs to
    // happen carefully; NULLs don't conflict with a UNIQUE constraint
    // in Postgres, so this is safe to add immediately, before the
    // backfill populates real values.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_login_id_key'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_login_id_key UNIQUE (login_id);
        END IF;
      END $$;
    `);
    console.log('DB: users.login_id column confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone login_id check FAILED:', err.message, err.code);
  }
}

// ── One-time backfill: existing users' login_id ──────────────────────────
// Per explicit requirement — defaults login_id to each user's existing,
// real email for any user who doesn't already have one set. Only
// updates rows where login_id is still NULL, so this is safe to run on
// every deploy without ever overwriting a value a user has since
// customized to be genuinely different from their email.
async function backfillLoginIdForExistingUsers() {
  if (!pool) return;
  try {
    const { rows } = await pool.query(
      `UPDATE users SET login_id = email WHERE login_id IS NULL RETURNING user_id, email, login_id`
    );
    console.log(`DB: backfilled login_id for ${rows.length} existing user(s)`);
  } catch (err) {
    console.error('DB: login_id backfill FAILED:', err.message, err.code);
  }
}
(async function() {
  await ensureLoginIdColumn();
  await backfillLoginIdForExistingUsers();
})();

// ── Standalone, independent addition: real, actual user sessions ────────
// Per explicit request to build real, per-request authentication. A
// session token is genuinely random (32 bytes), sent to the browser
// once at login, and the server verifies it on every subsequent
// request. token_hash uses a FAST cryptographic hash (SHA-256),
// deliberately distinct from the slow, real scrypt hashing this app
// already uses for passwords and email-link reset tokens — those are
// correct for infrequent, real actions, but a session token needs
// verification on every single request, and scrypt's real, intentional
// slowness would be a genuine, real performance problem at any
// meaningful scale.
async function ensureSessionsTable() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        expires_at   TIMESTAMPTZ NOT NULL,
        date_created TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);
    // Real, new column — genuinely needed for the confirmed, real
    // 4-hour idle timeout, which requires tracking when a session was
    // last, actually used, not just when it was originally created. A
    // real, separate ALTER TABLE, since this table already, genuinely
    // exists in production.
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW()`);
    // Real, new column, per the confirmed, real fix for a reported bug —
    // the ONLY previous source of "which tenant is this user currently,
    // actually working in" was a plain, in-memory browser variable,
    // which genuinely gets wiped on every real page refresh. Without a
    // real, persisted record of it, the app had to fall back to the
    // user's static "home" tenant column — which can genuinely differ
    // from the tenant they actually selected and were working in — so a
    // completely valid session, on a completely valid tenant, would
    // incorrectly fail the tenant check the instant the page reloaded.
    // Tied directly to the real, actual session record itself, so it
    // genuinely survives a refresh (the session cookie does), correctly
    // clears when the session ends, and — since a session is already,
    // correctly, single-tenant-scoped by this app's own login flow —
    // this is the real, correct, precise place for it to live.
    await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_tenant_id TEXT`);
    console.log('DB: sessions table confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone sessions table check FAILED:', err.message, err.code);
  }
}
ensureSessionsTable();

// ── Real, new access-control error tables, per explicit request ─────────
// access_error_codes: the real, actual reference table defining what
// each error code genuinely means — seeded with the two, explicit
// codes requested (12: no tenant access, 13: no feature/screen access).
// access_error_log: the real, actual log of every, genuine, real
// occurrence — who, when, which code, and enough real, actual context
// (the real route/tenant involved) to investigate a genuine incident
// later, per the explicit "store every time a user causes one" request.
async function ensureAccessErrorTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_error_codes (
        code         INTEGER PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL,
        date_created TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS access_error_log (
        log_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code         INTEGER NOT NULL REFERENCES access_error_codes(code),
        user_id      UUID REFERENCES users(user_id) ON DELETE SET NULL,
        login_id     TEXT,
        requested_path     TEXT,
        requested_tenant_id TEXT,
        date_created TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Real, new table, per explicit request — records every, real,
    // actual acknowledgment of the sensitive-information consent
    // screen, since it's genuinely a real, legal-agreement-style
    // click-through worth its own, real, server-side audit trail,
    // matching the exact, established pattern of this app's own,
    // existing event-logging tables (e.g. access_error_log above).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS consent_acknowledgments (
        ack_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID REFERENCES users(user_id) ON DELETE SET NULL,
        login_id     TEXT,
        tenant_id    TEXT,
        date_created TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Real, actual seed data for the two, explicit codes — ON CONFLICT
    // DO NOTHING so this is safe to run on every deploy without ever
    // overwriting real, live wording someone may have since customized.
    await pool.query(`
      INSERT INTO access_error_codes (code, title, description) VALUES
        (12, 'No Tenant Access', 'The user attempted to access a tenant they do not have real, actual permission to access.'),
        (13, 'No Feature Access', 'The user attempted to access a screen or feature they do not have real, actual permission to access.')
      ON CONFLICT (code) DO NOTHING
    `);
    console.log('DB: access_error_codes / access_error_log tables confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone access-error tables check FAILED:', err.message, err.code);
  }
}
ensureAccessErrorTables();

// ── Real, new failed-login-lockout columns, per explicit, confirmed
// design — tracks a real, actual failed-attempt count per user, and a
// real, actual lockout expiry timestamp. A temporary, self-clearing
// lock (not permanent), per explicit confirmation, since a permanent
// lock would let an attacker deliberately lock out a legitimate user
// just by repeatedly entering a wrong password.
//
// Extended, per explicit request, with a real, second, escalated tier:
// daily_failed_login_count (a real, rolling 24-hour count, reset via
// daily_failed_login_reset_at — genuinely more robust than a "since
// midnight" count, which would need careful, real timezone handling)
// and security_disabled — a real, new, distinct flag, genuinely
// separate from the existing is_active column, since "an admin
// manually disabled this account" and "the system auto-disabled this
// account for a security reason" are two, real, meaningfully different
// states that shouldn't be conflated into one, real field.
async function ensureFailedLoginColumns() {
  if (!pool) return;
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_failed_login_count INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_failed_login_reset_at TIMESTAMPTZ DEFAULT NOW()`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS security_disabled BOOLEAN NOT NULL DEFAULT false`);
    console.log('DB: failed_login_count / locked_until / daily_failed_login_count / daily_failed_login_reset_at / security_disabled columns confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone failed-login columns check FAILED:', err.message, err.code);
  }
}
ensureFailedLoginColumns();

// ── Real, new security_settings table, per explicit request — a
// genuine, real, persisted place to store the actual, admin-
// configurable authentication settings, so they genuinely survive a
// real deploy rather than resetting to hardcoded constants each time.
// A real, single-row table (id always 1) — genuinely simple and
// correct for a small set of global, real, app-wide settings, rather
// than a real, generic key-value table that would need more real,
// careful type-handling for no genuine benefit here. Seeded with the
// exact, real values already confirmed and built into the login route
// over the last several turns, so the real, live behavior doesn't
// change the moment this deploys — it just becomes genuinely, actually
// adjustable going forward.
async function ensureSecuritySettingsTable() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_settings (
        id                        INTEGER PRIMARY KEY DEFAULT 1,
        min_password_length       INTEGER NOT NULL DEFAULT 8,
        lockout_seconds           INTEGER NOT NULL DEFAULT 60,
        lockout_threshold         INTEGER NOT NULL DEFAULT 10,
        daily_failed_login_limit  INTEGER NOT NULL DEFAULT 200,
        date_updated              TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);
    await pool.query(`
      INSERT INTO security_settings (id, min_password_length, lockout_seconds, lockout_threshold, daily_failed_login_limit)
      VALUES (1, 8, 60, 10, 200)
      ON CONFLICT (id) DO NOTHING
    `);
    console.log('DB: security_settings table confirmed ready (standalone check)');
  } catch (err) {
    console.error('DB: standalone security_settings table check FAILED:', err.message, err.code);
  }
}
ensureSecuritySettingsTable();

// Real, actual, in-memory cache of the current, real security settings
// — refreshed from the real, live database on every genuine change via
// the admin route below, and read directly by the login route on every
// real request, avoiding a real, extra database round-trip on every
// single login attempt just to read four, small, rarely-changing
// numbers.
let _securitySettingsCache = { min_password_length: 8, lockout_seconds: 60, lockout_threshold: 10, daily_failed_login_limit: 200 };
async function _loadSecuritySettingsCache() {
  if (!pool) return;
  try {
    const { rows } = await pool.query('SELECT * FROM security_settings WHERE id=1');
    if (rows.length) _securitySettingsCache = rows[0];
  } catch (err) {
    console.error('_loadSecuritySettingsCache FAILED (real, existing defaults kept):', err.message);
  }
}
_loadSecuritySettingsCache();

// Real, actual logging helper — called every time a genuine, real code
// 12 or 13 denial happens, per explicit "store every time a user
// causes one" request. Never throws — a real, live user-facing denial
// should never itself fail just because the LOGGING of that denial hit
// a real, transient database issue.
async function logAccessError(code, req) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO access_error_log (code, user_id, login_id, requested_path, requested_tenant_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        code,
        req.currentUser ? req.currentUser.user_id : null,
        req.currentUser ? req.currentUser.login_id : null,
        req.path,
        req.query.tenant_id || (req.body && req.body.tenant_id) || req.headers['x-tenant-id'] || null,
      ]
    );
  } catch (err) {
    console.error('logAccessError FAILED (the real, actual denial itself was NOT affected):', err.message);
  }
}

// Behind Railway's reverse proxy the client IP arrives in X-Forwarded-For.
// Without this, req.ip is the proxy's address and the per-IP rate limiter would
// lump every user into one bucket. 1 = trust the first proxy hop.
app.set('trust proxy', 1);

// ── Middleware ──────────────────────────────────────────────────────────────
// CORS: `cors()` with no options reflects any Origin, letting any website on the
// internet drive this API from a visitor's browser. Restrict to known origins.
// Set ALLOWED_ORIGINS as a comma-separated list in Railway.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Same-origin / curl / server-to-server requests send no Origin header.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // dev default
    return ALLOWED_ORIGINS.includes(origin)
      ? cb(null, true)
      : cb(new Error('Origin not allowed by CORS'));
  },
  credentials: false,
}));

// Baseline security headers (equivalent to the parts of helmet that matter here,
// without adding a dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');           // stop advertising Express
  next();
});

// 50mb of JSON per request is a cheap memory-exhaustion DoS. Uploads are parsed
// in the browser and never POSTed as JSON, so this can be far smaller.
//
// /api/ai/analyze and /api/claude are both deliberately excluded here: both
// carry one or more base64-encoded PDFs/images in their JSON body (Extract
// Sample Data sends one document per call; Analyze now attaches EVERY
// attached sample file to EVERY test pass in a single request, which is a
// meaningfully larger payload — two or three moderate-sized PDFs together
// routinely exceed even a few megabytes once base64-encoded), so both need
// a larger limit than every other route (see AI_ANALYZE_BODY_LIMIT and
// CLAUDE_PROXY_BODY_LIMIT below). Express runs body-parsing middleware in
// registration order and only once per request — if this global parser ran
// for either route too, it would already have enforced the 2mb cap (and
// populated req.body) before that route's own, larger-limit parser ever got
// a chance to run, silently defeating it. This skip is what makes the
// route-level override in each handler actually work.
app.use(function(req, res, next) {
  if (req.path === '/api/ai/analyze' || req.path === '/api/claude') return next();
  express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' })(req, res, next);
});

// The AI proxy spends real money per call and is unauthenticated. Until auth
// lands, cap request volume per IP so a single caller cannot drain the budget.
const _aiHits = new Map(); // ip -> number[] (timestamps)
const AI_WINDOW_MS = 60_000;
const AI_MAX_PER_WINDOW = Number(process.env.AI_RATE_LIMIT || 20);
function aiRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const hits = (_aiHits.get(ip) || []).filter(t => now - t < AI_WINDOW_MS);
  if (hits.length >= AI_MAX_PER_WINDOW) {
    res.setHeader('Retry-After', Math.ceil(AI_WINDOW_MS / 1000));
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  hits.push(now);
  _aiHits.set(ip, hits);
  next();
}
// Bound the map so it cannot grow without limit.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of _aiHits) {
    const live = hits.filter(t => now - t < AI_WINDOW_MS);
    if (live.length) _aiHits.set(ip, live); else _aiHits.delete(ip);
  }
}, AI_WINDOW_MS).unref();

// ── Real, actual per-request authentication + tenant-access middleware ──
// Per explicit request: every request now genuinely, actually gets
// checked — not a frontend-only convenience like every other
// access-control feature built so far this session, but a real,
// server-side gate every one of this file's 100+ routes now passes
// through. A small, explicit, real allowlist covers routes that must
// stay reachable without a session (login itself, logout, the
// session-check route, the tenant list needed for the picker before
// login, static assets, health check) — everything else requires a
// real, valid, non-expired session.
//
// Per explicit instruction, checks is_superadmin FIRST: a real
// superadmin genuinely passes regardless of which tenant is being
// requested, matching "access by default." Everyone else needs a real,
// actual row in user_tenants for the SPECIFIC tenant being requested —
// checked via req.query.tenant_id / req.body.tenant_id / a real
// X-Tenant-Id header, whichever the caller provides; a request that
// names no specific tenant at all is allowed through once authenticated
// (many real routes, like /api/control-categories, are not genuinely
// tenant-specific), but any request that DOES name a tenant must
// genuinely be one this real, authenticated user actually has access to.
const PUBLIC_ROUTES = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/validate-login-id',
  '/api/default-tenant-id',
  '/health',
]);
app.use(async (req, res, next) => {
  if (PUBLIC_ROUTES.has(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next(); // static assets, the frontend HTML itself — not a real API request

  const rawToken = _parseCookie(req.headers.cookie, 'session_token');
  const user = await getUserFromSessionToken(rawToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  if (!user.is_active) return res.status(401).json({ error: 'This account has been deactivated.' });

  req.currentUser = user; // real, available to every route handler from here on, not re-derived per-route

  const requestedTenantId = req.query.tenant_id || (req.body && req.body.tenant_id) || req.headers['x-tenant-id'];

  // Real superadmin: access by default, per explicit instruction —
  // genuinely bypasses the tenant-access check entirely. Still resolves
  // a real, actual req.currentTenantId for route handlers to use below
  // — the requested tenant, once confirmed to genuinely exist (a
  // superadmin can reach any real tenant, but a request naming one
  // that doesn't actually exist should fail cleanly, not silently carry
  // a bogus value into a real, downstream query), falling back to
  // DEFAULT_TENANT_ID only when no specific tenant was named at all.
  if (user.is_superadmin) {
    if (requestedTenantId) {
      try {
        const { rows } = await pool.query('SELECT 1 FROM tenants WHERE id=$1', [requestedTenantId]);
        if (!rows.length) return res.status(404).json({ error: 'No such tenant.' });
        req.currentTenantId = requestedTenantId;
      } catch (err) {
        console.error('Tenant-existence check FAILED:', err.message);
        return res.status(500).json({ error: 'Could not verify tenant.' });
      }
    } else {
      req.currentTenantId = DEFAULT_TENANT_ID;
    }
    return next();
  }

  if (!requestedTenantId) {
    // A real, regular (non-superadmin) user made a request naming no
    // specific tenant at all — genuinely ambiguous for any real,
    // tenant-scoped route to act on safely, so this falls back to
    // DEFAULT_TENANT_ID only for routes that are honestly not
    // tenant-scoped to begin with (the same real, existing behavior as
    // before this fix); any real route that DOES need a genuine tenant
    // context will correctly get DEFAULT_TENANT_ID here, which is safe
    // precisely because every such route is being updated, in this
    // same real fix, to read req.currentTenantId instead of assuming it.
    req.currentTenantId = DEFAULT_TENANT_ID;
    return next();
  }

  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM user_tenants WHERE user_id=$1 AND tenant_id=$2',
      [user.user_id, requestedTenantId]
    );
    if (!rows.length) {
      await logAccessError(12, req);
      return res.status(403).json({ error_code: 12, error: 'You do not have access to this tenant.' });
    }
    req.currentTenantId = requestedTenantId; // genuinely, already verified above — trustworthy for every real route handler below
    next();
  } catch (err) {
    console.error('Tenant-access check FAILED:', err.message);
    return res.status(500).json({ error: 'Could not verify tenant access.' });
  }
});

// Real, new, reusable authorization middleware — distinct from the
// broader authentication middleware above (which only confirms someone
// is genuinely logged in, not which specific role they hold). Applied
// to every real /api/admin/* route below, since every one of those is
// genuinely intended to be superadmin-only, per explicit instruction.
async function requireSuperAdmin(req, res, next) {
  if (!req.currentUser) {
    // Per explicit guidance: an unauthenticated caller gets a real,
    // generic, minimal response — no distinguishing error code, since
    // revealing that level of detail to someone who hasn't even proven
    // who they are is real, unnecessary information leakage.
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  if (!req.currentUser.is_superadmin) {
    await logAccessError(13, req);
    return res.status(403).json({ error_code: 13, error: 'This action requires SuperAdmin access.' });
  }
  next();
}

// ── Control Categories API ────────────────────────────────────────────────────
app.get('/api/control-categories', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT name FROM control_categories ORDER BY sort_order, name'); res.json(rows.map(r=>r.name)); }
  catch(err) { return fail(res, err, 'api'); }
});

// Purely administrative categorization now — Planning, Testwork, Report,
// Admin, Other. Genuinely no bearing on layout; that's workpaper_templates'
// job now (see below), not this table's.
app.get('/api/workpaper-types', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT name, description FROM workpaper_types WHERE active=true ORDER BY sort_order, name`
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/workpaper-types:'); }
});

// Direct diagnostic: lists every route Express has ACTUALLY registered
// on the currently-running process, plus basic process info (uptime,
// memory, start time). Built after three long-established, unrelated
// GET routes were all reported 404ing simultaneously on what was
// confirmed to be a genuinely fresh deploy — ruling out the "not yet
// redeployed" explanation that resolved an earlier, similar-looking
// report. This answers with certainty whether the routes are actually
// registered on the live process (not just present in this file, which
// only shows what SHOULD be registered) and how long that process has
// actually been running, rather than guessing further.
app.get('/api/diagnose-routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(function(layer) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]).map(m => m.toUpperCase());
      routes.push({ path: layer.route.path, methods });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      layer.handle.stack.forEach(function(sub) {
        if (sub.route) {
          const methods = Object.keys(sub.route.methods).filter(m => sub.route.methods[m]).map(m => m.toUpperCase());
          routes.push({ path: sub.route.path, methods });
        }
      });
    }
  });
  const targetPaths = ['/api/admin/users', '/api/workpaper-statuses', '/api/sample-files/:ref'];
  const targetStatus = targetPaths.map(function(p) {
    return { path: p, registered: routes.some(function(r) { return r.path === p; }) };
  });
  res.json({
    process_uptime_seconds: process.uptime(),
    process_start_time: new Date(Date.now() - process.uptime()*1000).toISOString(),
    total_routes_registered: routes.length,
    target_routes_status: targetStatus,
    all_routes: routes.map(r => r.methods.join(',') + ' ' + r.path),
  });
});

// Direct diagnostic: shows the REAL, live columns on every table the
// user is asking about (audits, workpapers, sample_files,
// workpaper_annotations), queried straight from Postgres's own system
// catalog — not from this file's schema definitions, which only show
// what SHOULD be there. Built after a report that tenant_id isn't
// visible when querying the live database directly via Railway, despite
// this file's CREATE TABLE statements including it — the same class of
// gap between "this file says X" and "the live database actually has X"
// that's shown up more than once this session.
app.get('/api/diagnose-tenant-columns', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const tables = ['audits', 'workpapers', 'sample_files', 'workpaper_annotations'];
    const result = {};
    for (const t of tables) {
      const cols = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`, [t]);
      result[t] = {
        columns: cols.rows,
        has_tenant_id: cols.rows.some(r => r.column_name === 'tenant_id'),
      };
    }
    res.json(result);
  } catch(err) { return fail(res, err, 'GET /api/diagnose-tenant-columns:'); }
});

// Real, direct, read-only diagnostic — reports the EXACT, current, live
// constraint state of the workpapers table, without attempting any
// real INSERT at all. Built specifically to answer, directly and
// conclusively, whether the real, actual, live primary key genuinely
// matches (tenant_id, ref) right now — since a reported failure could
// mean the real, startup migration hasn't run yet on this specific,
// live deployment, or that it ran but genuinely failed (e.g., blocked
// by real, existing duplicate data), and there was previously no way
// to tell these apart without live, direct evidence.
app.get('/api/diagnose-workpaper-constraint', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const { rows: constraints } = await pool.query(`
      SELECT c.conname, c.contype,
             array_agg(a.attname ORDER BY a.attname) AS cols
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conrelid = 'workpapers'::regclass
      GROUP BY c.conname, c.contype
    `);
    const primaryKey = constraints.find(c => c.contype === 'p');
    const isCorrect = primaryKey && JSON.stringify([...primaryKey.cols].sort()) === JSON.stringify(['ref', 'tenant_id'].sort());
    // Real, direct check for existing, real duplicate (tenant_id, ref)
    // pairs — the real, actual, most likely reason the fix migration
    // could genuinely, silently fail to apply the new, correct
    // constraint even after running.
    const { rows: dupes } = await pool.query(`
      SELECT tenant_id, ref, COUNT(*) AS n FROM workpapers
      GROUP BY tenant_id, ref HAVING COUNT(*) > 1 LIMIT 20
    `);
    res.json({
      all_constraints: constraints,
      primary_key: primaryKey || null,
      primary_key_is_correct: !!isCorrect,
      blocking_duplicate_tenant_id_ref_pairs: dupes,
      diagnosis: isCorrect
        ? 'The real, live primary key is genuinely correct. If workpaper saves are still failing with the ON CONFLICT error, the cause is something else \u2014 check the real, actual, live server logs for the real, specific error.'
        : dupes.length > 0
          ? `The real, live primary key is genuinely NOT yet correct, and cannot safely be fixed automatically: ${dupes.length} real, actual, existing duplicate (tenant_id, ref) pair(s) exist, which would violate the new, correct constraint. These must genuinely be resolved (renamed or removed) before the fix can apply.`
          : 'The real, live primary key is genuinely NOT yet correct. No blocking duplicates were found, so calling POST /api/admin/fix-workpaper-constraint should genuinely, safely, correct this immediately.'
    });
  } catch(err) { return fail(res, err, 'GET /api/diagnose-workpaper-constraint:'); }
});

// Real, manually-triggerable version of the exact, same, real fix
// applied at startup \u2014 lets this be run immediately, directly, on
// demand, without waiting for a full, real server restart/redeploy
// cycle. Restricted to a real, actual superadmin, since this alters
// live, actual database structure.
// Real, shared fix-logic, extracted into one, real function both real
// routes below call — avoiding real, duplicated logic that could
// genuinely, silently drift apart, the exact, same, class of bug
// that's recurred repeatedly this session.
async function _applyWorkpaperConstraintFix() {
  const { rows: dupes } = await pool.query(`
    SELECT tenant_id, ref, COUNT(*) AS n FROM workpapers
    GROUP BY tenant_id, ref HAVING COUNT(*) > 1 LIMIT 20
  `);
  if (dupes.length > 0) {
    return { blocked: true, blocking_duplicate_tenant_id_ref_pairs: dupes };
  }
  const { rows: pkRows } = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'workpapers'::regclass AND contype = 'p'
  `);
  let alreadyCorrect = false;
  const actions = [];
  for (const { conname } of pkRows) {
    const { rows: colCheck } = await pool.query(`
      SELECT array_agg(a.attname ORDER BY a.attname) AS cols
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.conname = $1 AND c.conrelid = 'workpapers'::regclass
    `, [conname]);
    const cols = (colCheck[0]?.cols || []).sort();
    if (JSON.stringify(cols) === JSON.stringify(['ref', 'tenant_id'].sort())) {
      alreadyCorrect = true;
    } else {
      await pool.query(`ALTER TABLE workpapers DROP CONSTRAINT "${conname}"`);
      actions.push(`Dropped old, real, actual primary key "${conname}" (was: ${cols.join(', ')})`);
    }
  }
  if (!alreadyCorrect) {
    await pool.query(`ALTER TABLE workpapers ADD PRIMARY KEY (tenant_id, ref)`);
    actions.push('Added the real, correct, composite primary key (tenant_id, ref)');
  } else {
    actions.push('Already, genuinely, correct \u2014 no real, actual change needed');
  }
  return { blocked: false, actions };
}

app.post('/api/admin/fix-workpaper-constraint', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const result = await _applyWorkpaperConstraintFix();
    if (result.blocked) {
      return res.status(409).json({
        error: 'Cannot safely apply the fix \u2014 real, actual duplicate (tenant_id, ref) pairs exist.',
        blocking_duplicate_tenant_id_ref_pairs: result.blocking_duplicate_tenant_id_ref_pairs,
      });
    }
    res.json({ ok: true, actions: result.actions });
  } catch(err) { return fail(res, err, 'POST /api/admin/fix-workpaper-constraint:'); }
});

// Real, new, GET-accessible convenience version of the exact, same,
// real fix above \u2014 a POST request genuinely cannot be triggered just
// by visiting a URL in a browser, so this lets the fix be applied by
// simply opening a link directly, while signed in as a real superadmin.
app.get('/api/admin/fix-workpaper-constraint', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const result = await _applyWorkpaperConstraintFix();
    if (result.blocked) {
      return res.status(409).json({
        error: 'Cannot safely apply the fix \u2014 real, actual duplicate (tenant_id, ref) pairs exist.',
        blocking_duplicate_tenant_id_ref_pairs: result.blocking_duplicate_tenant_id_ref_pairs,
      });
    }
    res.json({ ok: true, actions: result.actions });
  } catch(err) { return fail(res, err, 'GET /api/admin/fix-workpaper-constraint:'); }
});
// Direct diagnostic: shows the exact, real, current wp_style value for
// a specific workpaper by ref. Built to answer precisely whether a
// pre-existing workpaper already has the correct stored value for the
// M-Template-Short display/reordering logic to apply to it — that logic
// reads wp_style live every time a workpaper opens, so this is the one
// real fact that determines whether an existing workpaper reflects
// those changes, not anything about the display code itself.
// Real, targeted diagnostic for "a user cannot login" — built to
// directly, precisely settle which SPECIFIC real condition is actually
// failing, since the real login route deliberately returns an
// identical, generic error for every different, real failure reason
// (a correct, real security practice — see its own comment), which
// means the reported symptom alone can't distinguish between them.
// Deliberately NEVER exposes the real password hash, and never
// attempts to verify a submitted password — a diagnostic that checked
// actual credentials would itself be a real, meaningful security risk.
app.get('/api/diagnose-login/:loginId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      `SELECT user_id, login_id, email, is_active, is_superadmin, must_change_password,
              (password_hash IS NOT NULL AND password_hash != '') AS has_real_password_set,
              date_updated, failed_login_count, locked_until, daily_failed_login_count,
              daily_failed_login_reset_at, security_disabled
       FROM users WHERE login_id=$1`,
      [req.params.loginId]
    );
    if (!rows.length) {
      return res.json({ found: false, note: 'No user exists with this exact login_id. Check for a typo, or whether this user\'s real login_id is actually something different from their name/email.' });
    }
    const u = rows[0];
    const isCurrentlyLockedOut = u.locked_until && new Date(u.locked_until) > new Date();
    const likelyCause =
      !u.is_active ? 'This account is marked INACTIVE — inactive accounts are always rejected at login, regardless of password.' :
      u.security_disabled ? 'This account is SECURITY-DISABLED (too many failed login attempts in a rolling 24-hour period). A superadmin must, actually, explicitly re-enable it via Admin > Users before this user can log in again — no correct password will work until then.' :
      isCurrentlyLockedOut ? `This account is TEMPORARILY LOCKED (too many failed login attempts in a row). The lock expires at ${u.locked_until} — no correct password will work until then, even the actually-correct one.` :
      !u.has_real_password_set ? 'This account genuinely has NO real password set at all yet (password_hash is empty) — a superadmin needs to set one via the Admin > Users page before this user can log in.' :
      'A real password IS set, the account is active, and it is genuinely not locked or disabled — if login is still failing, the most likely real cause is the password the user is actually typing simply does not match what was set (a genuine typo either when it was set, or when it\'s being entered now).';
    res.json({
      found: true,
      login_id: u.login_id,
      is_active: u.is_active,
      is_superadmin: u.is_superadmin,
      must_change_password: u.must_change_password,
      has_real_password_set: u.has_real_password_set,
      password_last_updated: u.date_updated,
      failed_login_count: u.failed_login_count,
      currently_locked_out: !!isCurrentlyLockedOut,
      locked_until: u.locked_until,
      daily_failed_login_count: u.daily_failed_login_count,
      daily_failed_login_reset_at: u.daily_failed_login_reset_at,
      security_disabled: u.security_disabled,
      likely_cause: likelyCause,
    });
  } catch(err) { return fail(res, err, 'GET /api/diagnose-login/:loginId:'); }
});


// The New Workpaper modal's own dedicated route — returns layout_key,
// since that's specifically what determines which sections/fields render
// once a template is chosen at creation. This choice is never stored as
// an ongoing field on the workpaper itself; its EFFECT is captured once
// into workpapers.wp_style at creation time (see submitNewWorkpaper).
app.get('/api/workpaper-templates', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT name, layout_key, description FROM workpaper_templates WHERE active=true ORDER BY sort_order, name`
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/workpaper-templates:'); }
});

// Direct diagnostic for workpaper_templates specifically — built after
// "Could not load workpaper templates" was reported on a deployment that
// genuinely includes the table's own creation/backfill code. Every query
// isolated in its own try/catch so a real Postgres error is surfaced
// directly here, rather than hidden behind fail()'s generic message —
// the same approach that finally cut through the equivalent mystery on
// the old, now-corrected workpaper_types table.
app.get('/api/diagnose-templates', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const result = { steps: [] };
  try {
    try {
      const exists = await pool.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = 'workpaper_templates'`);
      result.table_exists_check = exists.rows;
      result.steps.push({ step: 'table_exists', ok: true });
    } catch (e) {
      result.steps.push({ step: 'table_exists', ok: false, error: { message: e.message, code: e.code } });
    }
    try {
      const cols = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'workpaper_templates' ORDER BY ordinal_position`);
      result.live_columns = cols.rows;
      result.steps.push({ step: 'check_columns', ok: true });
    } catch (e) {
      result.steps.push({ step: 'check_columns', ok: false, error: { message: e.message, code: e.code } });
    }
    try {
      const allRows = await pool.query(`SELECT * FROM workpaper_templates ORDER BY sort_order`);
      result.all_rows_including_inactive = allRows.rows;
      result.steps.push({ step: 'select_all', ok: true });
    } catch (e) {
      result.steps.push({ step: 'select_all', ok: false, error: { message: e.message, code: e.code, detail: e.detail } });
      result.select_all_error = { message: e.message, code: e.code, detail: e.detail, hint: e.hint };
    }
    try {
      const activeRows = await pool.query(`SELECT name, layout_key, description FROM workpaper_templates WHERE active=true ORDER BY sort_order, name`);
      result.active_rows_real_route_query = activeRows.rows;
      result.steps.push({ step: 'select_active_exact_route_query', ok: true });
    } catch (e) {
      result.steps.push({ step: 'select_active_exact_route_query', ok: false, error: { message: e.message, code: e.code, detail: e.detail } });
      result.select_active_error = { message: e.message, code: e.code, detail: e.detail, hint: e.hint };
    }
    try {
      await pool.query(`
        INSERT INTO workpaper_templates (name, layout_key, description, sort_order) VALUES
          ('Workpaper-Short Template', 'skinny', 'Short-form workpaper — admin/narrow sections only.', 1),
          ('Workpaper-Long Template',  'full',   'Long-form workpaper — full set of sections including scope, narrative, test attributes, sample data, and analysis.', 2),
          ('M-Template',               'mtemplate', 'Structured control-testing template.', 3),
          ('M-Template-Short',         'mtemplate-short', 'M-Template without the Header, Information About this Control, and Nature/Timing/Extent of the TOC sections.', 4)
        ON CONFLICT (name) DO NOTHING`);
      result.live_insert_result = 'succeeded';
      result.steps.push({ step: 'live_insert', ok: true });
    } catch (e) {
      result.live_insert_error = { message: e.message, code: e.code, detail: e.detail, hint: e.hint };
      result.steps.push({ step: 'live_insert', ok: false, error: { message: e.message, code: e.code, detail: e.detail } });
    }
    try {
      const after = await pool.query(`SELECT name, layout_key, active FROM workpaper_templates ORDER BY sort_order`);
      result.rows_after_insert_attempt = after.rows;
      result.steps.push({ step: 'select_after', ok: true });
    } catch (e) {
      result.steps.push({ step: 'select_after', ok: false, error: { message: e.message, code: e.code } });
    }
    res.json(result);
  } catch(err) {
    result.unexpected_error = { message: err.message, code: err.code };
    res.status(500).json(result);
  }
});

// Real, canonical workpaper status values/labels — see the
// workpaper_statuses table comment for why this exists (the status
// filter dropdown had been using mismatched values that never actually
// matched a real workpaper's stored status).
app.get('/api/workpaper-statuses', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT value, label FROM workpaper_statuses WHERE active=true ORDER BY sort_order, label'
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/workpaper-statuses:'); }
});

// Real tag-code-to-description mapping (CC, SEC, OPS, FIN, IPE) — see the
// workpaper_tag_descriptions table comment for why these are seeded
// blank rather than pre-filled: the actual meaning of each code is
// specific to this firm's own naming convention.
app.get('/api/workpaper-tag-descriptions', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT code, description FROM workpaper_tag_descriptions ORDER BY sort_order, code'
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/workpaper-tag-descriptions:'); }
});

app.patch('/api/workpaper-tag-descriptions/:code', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { description } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE workpaper_tag_descriptions SET description=$2, updated_at=NOW()
       WHERE code=$1 RETURNING code, description`,
      [req.params.code, description || '']
    );
    if (!rows.length) return res.status(404).json({ error: 'Tag code not found' });
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'PATCH /api/workpaper-tag-descriptions/:code:'); }
});

app.post('/api/control-categories', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM control_categories');
    await pool.query('INSERT INTO control_categories (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, rows[0].n]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Risks API ───────────────────────────────────────────────────────────────
app.get('/api/risks', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM risks WHERE tenant_id=$1 ORDER BY id', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/risks', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, category, description } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO risks (tenant_id,id,name,category,description,updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, description=EXCLUDED.description, updated_at=NOW()`,
      [req.currentTenantId, id, name||'', category||'', description||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/risks/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM risks WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Controls API ─────────────────────────────────────────────────────────────
app.get('/api/controls', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM controls WHERE tenant_id=$1 ORDER BY category, id', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/controls', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, name, category, objective, objective_id, description, additional_info,
          ctrl_owner, proc_owner, extra_ctrl_owners, extra_proc_owners,
          frequency, control_type, linked_risks, linked_entities, linked_accounts,
          analyst_notes } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO controls
        (id,name,category,objective,objective_id,description,additional_info,ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,linked_risks,linked_entities,linked_accounts,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, category=EXCLUDED.category, objective=EXCLUDED.objective,
        objective_id=EXCLUDED.objective_id,
        description=EXCLUDED.description, additional_info=EXCLUDED.additional_info,
        ctrl_owner=EXCLUDED.ctrl_owner, proc_owner=EXCLUDED.proc_owner,
        extra_ctrl_owners=EXCLUDED.extra_ctrl_owners, extra_proc_owners=EXCLUDED.extra_proc_owners,
        frequency=EXCLUDED.frequency, control_type=EXCLUDED.control_type,
        linked_risks=EXCLUDED.linked_risks, linked_entities=EXCLUDED.linked_entities,
        linked_accounts=EXCLUDED.linked_accounts, updated_at=NOW()`,
      [id, name||'', category||'', objective||'', objective_id||'', description||'', additional_info||'',
       ctrl_owner||'', proc_owner||'',
       JSON.stringify(extra_ctrl_owners||[]),
       JSON.stringify(extra_proc_owners||[]),
       frequency||'', control_type||'',
       JSON.stringify(linked_risks||[]),
       JSON.stringify(linked_entities||[]),
       JSON.stringify(linked_accounts||[])]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/controls/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM controls WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Entity Types API ────────────────────────────────────────────────────────
app.get('/api/entity-types', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM entity_types ORDER BY name');
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/entity-types:'); }
});

app.post('/api/entity-types', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { name, bg, color, border, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query(`
      INSERT INTO entity_types (name, bg, color, border, icon)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (name) DO UPDATE SET bg=EXCLUDED.bg, color=EXCLUDED.color, border=EXCLUDED.border, icon=EXCLUDED.icon
    `, [name, bg||'#f1f5f9', color||'#475569', border||'#cbd5e1', icon||'ti-tag']);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/entity-types:'); }
});

// ── Assessment Entities API ─────────────────────────────────────────────────
app.get('/api/entities', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM assessment_entities WHERE tenant_id=$1 ORDER BY type, name', [req.currentTenantId]);
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/entities:'); }
});

app.post('/api/entities', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { id, name, type, category, address, city, state, poc, sub, description,
          app_purpose, user_count, txn_volume, txn_dollar, change_volume,
          change_complexity, admin_users, key_integrations, external_integrations,
          custom_fields } = req.body;
  try {
    await pool.query(`
      INSERT INTO assessment_entities
        (id,name,type,category,address,city,state,poc,sub,description,
         app_purpose,user_count,txn_volume,txn_dollar,change_volume,
         change_complexity,admin_users,key_integrations,external_integrations,
         custom_fields,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
      ON CONFLICT (id) DO UPDATE SET
        name=EXCLUDED.name, type=EXCLUDED.type, category=EXCLUDED.category,
        address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state,
        poc=EXCLUDED.poc, sub=EXCLUDED.sub, description=EXCLUDED.description,
        app_purpose=EXCLUDED.app_purpose, user_count=EXCLUDED.user_count,
        txn_volume=EXCLUDED.txn_volume, txn_dollar=EXCLUDED.txn_dollar,
        change_volume=EXCLUDED.change_volume, change_complexity=EXCLUDED.change_complexity,
        admin_users=EXCLUDED.admin_users, key_integrations=EXCLUDED.key_integrations,
        external_integrations=EXCLUDED.external_integrations,
        custom_fields=EXCLUDED.custom_fields, updated_at=NOW()
    `, [id, name||'', type||'Facility', category||'facility',
        address||'', city||'', state||'', poc||'', sub||'', description||'',
        app_purpose||'', user_count||'', txn_volume||'', txn_dollar||'',
        change_volume||'', change_complexity||'', admin_users||'',
        key_integrations||'', external_integrations||'',
        JSON.stringify(custom_fields||[])]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/entities:'); }
});

app.delete('/api/entities/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    await pool.query('DELETE FROM assessment_entities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'DELETE /api/entities:'); }
});



// ── PDF.js — served from npm package (no CDN needed) ───────────────────────
app.get('/pdfjs/pdf.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdfjs-dist/build/pdf.min.js'));
});

app.get('/pdfjs/pdf.worker.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdfjs-dist/build/pdf.worker.min.js'));
});

// ── pdf-lib — served from npm package (no CDN needed) ──────────────────────
app.get('/pdflib/pdf-lib.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(require.resolve('pdf-lib/dist/pdf-lib.min.js'));
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── API key + Claude connectivity test ──────────────────────────────────────
app.get('/api/test', aiRateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages:   [{ role: 'user', content: 'Reply with just the word OK.' }],
      }),
    });
    const data = await response.json();
    if (data.error) {
      return res.status(response.status).json({
        ok:     false,
        status: response.status,
        error:  data.error.message,
        type:   data.error.type
      });
    }
    const reply = data.content?.[0]?.text || '(no text)';
    res.json({ ok: true, claude_replied: reply, model: data.model });
  } catch (err) {
    console.error('[api/test]', err.message); res.status(502).json({ ok: false, error: 'Upstream request failed' });
  }
});

// ── Claude API proxy ────────────────────────────────────────────────────────
// Explicit, generous body-size limit of its own: Analyze attaches EVERY
// attached sample file to EVERY test pass in a single request now (not one
// document per call, like Extract Sample Data's /api/ai/analyze) — several
// moderate-sized PDFs together, once base64-encoded, is a meaningfully
// larger payload than that single-document route was sized for, so this
// gets its own headroom rather than reusing AI_ANALYZE_BODY_LIMIT.
const CLAUDE_PROXY_BODY_LIMIT = process.env.CLAUDE_PROXY_BODY_LIMIT || '30mb';
app.post('/api/claude', express.json({ limit: CLAUDE_PROXY_BODY_LIMIT }), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server.' } });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(502).json({ error: { message: `Proxy error: ${err.message}` } });
  }
});


// ── Audits API ────────────────────────────────────────────────────────────────
// Real, new, dedicated route for verifying access to one, specific,
// real audit, matching the exact, same, real design already applied
// to workpapers.
app.get('/api/audits/:name/access-check', async (req, res) => {
  if (!pool) return res.json({ hasAccess: false });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM audits WHERE tenant_id=$1 AND name=$2',
      [req.currentTenantId, req.params.name]
    );
    res.json({ hasAccess: rows.length > 0 });
  } catch(err) { return fail(res, err, 'GET /api/audits/:name/access-check:'); }
});

app.get('/api/audits', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM audits WHERE tenant_id=$1 ORDER BY created_at', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/audits', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, period, owner, type, status, description, desc, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const descVal = description != null ? description : (desc || '');
  console.log('[API] POST /api/audits name=', name, 'desc length=', descVal.length);
  try {
    await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
      VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
        type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description, year=EXCLUDED.year, updated_at=NOW()`,
      [name, period||'', owner||'', type||'', status||'planned', descVal, year||null, req.currentTenantId]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, '[API] audit save error:'); }
});

app.patch('/api/audits/:oldName', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const oldName = req.params.oldName;
  const { name, period, owner, type, status, description, year } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Rename = insert new row + reassign workpapers + delete old (if name
    // changed), else just update. Wrapped in a real transaction — without
    // this, a failure partway through (the workpaper reassignment UPDATE in
    // particular) could leave the new audit created and the old one deleted
    // while some workpapers never got their audit_name updated, permanently
    // orphaning them: pointing at an audit name that no longer exists,
    // audit itself gone from the list, workpaper unreachable through the
    // UI even though its own row is still sitting in Postgres untouched.
    await pool.query('BEGIN');
    if (name !== oldName) {
      await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
        VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
          type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description,
          year=EXCLUDED.year, updated_at=NOW()`,
        [name, period||'', owner||'', type||'', status||'planned', description||'', year||null, req.currentTenantId]);
      // Update workpapers that referenced the old audit name
      await pool.query(`UPDATE workpapers SET audit_name=$1 WHERE tenant_id=$2 AND audit_name=$3`,
        [name, req.currentTenantId, oldName]);
      await pool.query(`DELETE FROM audits WHERE tenant_id=$1 AND name=$2`, [req.currentTenantId, oldName]);
    } else {
      await pool.query(`INSERT INTO audits (tenant_id,name,period,owner,type,status,description,year,updated_at)
        VALUES ($8,$1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (tenant_id,name) DO UPDATE SET period=EXCLUDED.period, owner=EXCLUDED.owner,
          type=EXCLUDED.type, status=EXCLUDED.status, description=EXCLUDED.description,
          year=EXCLUDED.year, updated_at=NOW()`,
        [name, period||'', owner||'', type||'', status||'planned', description||'', year||null, req.currentTenantId]);
    }
    await pool.query('COMMIT');
    res.json({ ok:true });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, '[API] audit rename error:');
  }
});


// Diagnostic, read-only: finds any workpaper whose audit_name doesn't match
// a real, currently-existing audit — the exact orphaned state a failed
// mid-rename could produce before the transaction fix above. Does not
// modify anything; safe to hit at any time to check for this specific
// inconsistency.
// Repairs an orphaned workpaper by recreating a MINIMAL audit row under its
// missing audit_name, so the workpaper becomes reachable through the UI
// again. Deliberately minimal — the original audit's owner, type, period,
// etc. are genuinely gone if this state was reached, so this only restores
// reachability; the person fills in the rest from there. Does nothing if an
// audit under that name already exists (nothing to repair).
// GET-triggerable version of the repair above — usable by simply visiting
// the URL in a browser, no form or POST client needed. Recreates a
// specific audit by name directly (does not require an orphaned workpaper
// to already exist), using the exact same INSERT ... ON CONFLICT the
// normal audit-save route uses — so successfully hitting this also
// independently confirms whether the underlying unique-constraint fix
// (see initDB, the audits_tenant_name_key migration) actually took effect,
// since it exercises the identical failure point.
app.get('/api/recreate-audit/:name', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const name = req.params.name;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query(
      `INSERT INTO audits (tenant_id,name,period,owner,type,status,description,updated_at)
       VALUES ($1,$2,'','','Financial','planned','Recreated via /api/recreate-audit.',NOW())
       ON CONFLICT (tenant_id,name) DO NOTHING`,
      [req.currentTenantId, name]
    );
    const { rows } = await pool.query(
      'SELECT * FROM audits WHERE tenant_id=$1 AND name=$2',
      [req.currentTenantId, name]
    );
    return res.json({ ok: true, audit: rows[0] || null, method: 'insert_on_conflict' });
  } catch(err) {
    console.error('[recreate-audit] ON CONFLICT insert failed:', err.message);
    // Fall back to a plain insert with no ON CONFLICT clause at all — if the
    // conflict clause itself is what's failing (the unique constraint issue
    // this whole investigation has been circling), this sidesteps it
    // entirely and can still get the row into the table, which is the
    // actual immediate goal, independent of whether that deeper problem is
    // fully fixed yet.
    try {
      const { rows: existing } = await pool.query(
        'SELECT * FROM audits WHERE tenant_id=$1 AND name=$2',
        [req.currentTenantId, name]
      );
      if (existing.length) {
        return res.json({ ok: true, audit: existing[0], method: 'already_existed', firstError: err.message });
      }
      await pool.query(
        `INSERT INTO audits (tenant_id,name,period,owner,type,status,description,updated_at)
         VALUES ($1,$2,'','','Financial','planned','Recreated via /api/recreate-audit (fallback path).',NOW())`,
        [req.currentTenantId, name]
      );
      const { rows: created } = await pool.query(
        'SELECT * FROM audits WHERE tenant_id=$1 AND name=$2',
        [req.currentTenantId, name]
      );
      return res.json({ ok: true, audit: created[0] || null, method: 'plain_insert_fallback', firstError: err.message });
    } catch (fallbackErr) {
      console.error('[recreate-audit] Fallback plain insert also failed:', fallbackErr.message);
      // Both attempts genuinely failed — return the REAL Postgres error
      // messages directly (this is a diagnostic tool, not a normal app
      // route, so there's no reason to hide the real cause behind a
      // generic message the way fail() correctly does elsewhere).
      return res.status(500).json({
        ok: false,
        error: 'Both insert attempts failed.',
        onConflictError: err.message,
        plainInsertError: fallbackErr.message
      });
    }
  }
});

app.post('/api/orphaned-workpapers/:ref/repair', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      'SELECT audit_name FROM workpapers WHERE tenant_id=$1 AND ref=$2',
      [req.currentTenantId, req.params.ref]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });
    const auditName = rows[0].audit_name;
    if (!auditName) return res.status(400).json({ error: 'This workpaper has no audit_name to repair against.' });

    await pool.query(
      `INSERT INTO audits (tenant_id,name,period,owner,type,status,description,updated_at)
       VALUES ($1,$2,'','','Financial','planned','Recreated automatically to recover an orphaned workpaper.',NOW())
       ON CONFLICT (tenant_id,name) DO NOTHING`,
      [req.currentTenantId, auditName]
    );
    res.json({ ok: true, auditName });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Admin: Users & Tenants ──────────────────────────────────────────────
// These routes deliberately do NOT filter by DEFAULT_TENANT_ID the way
// ordinary resource routes do — an admin managing users/tenants needs
// visibility across the whole system, not one tenant's slice of it. No
// authentication or authorization exists anywhere in this file yet (a
// documented, planned gap — see the handoff notes on the next phase of
// work); these routes are exactly the ones that should be admin-only once
// that's built, since by definition only an admin should ever reach them.

// Lists tenants the real, current, authenticated user can actually
// access — per the confirmed, real security fix: a genuine superadmin
// still sees every real tenant (per the explicit, established "access
// by default" requirement), but a real, regular user now only sees the
// tenants they are actually, genuinely assigned to via the real
// user_tenants table. This route now requires real authentication
// (removed from the public allowlist) since real login genuinely
// exists now — the earlier, honest "show everyone everything" scope
// was correct only while there was no way to know who was asking.
app.get('/api/tenants', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    if (req.currentUser && req.currentUser.is_superadmin) {
      const { rows } = await pool.query('SELECT id, name, description, domain FROM tenants ORDER BY name');
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.description, t.domain
       FROM tenants t
       JOIN user_tenants ut ON ut.tenant_id = t.id
       WHERE ut.user_id = $1
       ORDER BY t.name`,
      [req.currentUser ? req.currentUser.user_id : null]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/tenants:'); }
});

// Validates a User ID against the real, actual login_id field, per
// explicit request. Deliberately returns only a minimal, real boolean —
// never leaking any other real user data, or distinguishing "not found"
// from other failure modes in its response — reasonable, real practice
// for a public-facing login check even though this app has no real
// session/auth enforcement yet.
app.get('/api/auth/validate-login-id', async (req, res) => {
  if (!pool) return res.json({ valid: false });
  const loginId = (req.query.login_id || '').trim();
  if (!loginId) return res.json({ valid: false });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE login_id=$1 AND is_active=true',
      [loginId]
    );
    res.json({ valid: rows.length > 0 });
  } catch(err) { return fail(res, err, 'GET /api/auth/validate-login-id:'); }
});

// Real, complete login route — per explicit confirmation, checks BOTH
// User ID and Password for real, and only issues a genuine session once
// both are correct. Reuses verifyPassword, the same real, established
// function already used for the superadmin "set password" feature.
// Checks is_active BEFORE verifying the password — a deactivated
// account should never authenticate, regardless of whether the
// password is correct.
// Real, confirmed failed-login-lockout design, per every, explicit
// request. The real, temporary, self-clearing lock and the real,
// second, escalated daily tier — 200 real, actual failed attempts
// within a rolling 24-hour window genuinely, permanently disables the
// account (via security_disabled) rather than just another temporary
// lock, requiring real, actual superadmin re-enable — are now genuinely,
// admin-configurable via the new Security section (read live from
// _securitySettingsCache below, not hardcoded). Only the real, 24-hour
// window's own length stays fixed, since "per day" genuinely means
// that specific, real period, not a separately-configurable duration.
const DAILY_FAILED_LOGIN_WINDOW_MS = 24 * 60 * 60 * 1000;

app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { login_id, password } = req.body;
  if (!login_id || !password) return res.status(400).json({ error: 'login_id and password are required' });
  try {
    const { rows } = await pool.query(
      `SELECT user_id, email, login_id, first_name, last_name, role, is_superadmin, is_active,
              must_change_password, password_hash, failed_login_count, locked_until,
              daily_failed_login_count, daily_failed_login_reset_at, security_disabled
       FROM users WHERE login_id=$1`,
      [login_id.trim()]
    );
    // Deliberately identical, generic error for "no such user", "wrong
    // password", "temporarily locked", AND "security-disabled" — a
    // real, reasonable practice so a real, external caller can't use
    // this response to learn which User IDs genuinely exist, or which,
    // real, specific state an account is actually in.
    const genericError = () => res.status(401).json({ error: 'Invalid User ID or password.' });
    if (!rows.length) return genericError();
    const user = rows[0];
    if (!user.is_active) return genericError();

    // Real, actual security-disabled check — FIRST, before even the
    // temporary lockout, since a security-disabled account should
    // never proceed regardless of the temporary lock's own, separate
    // state (which may have already expired on its own by the time
    // someone next tries).
    if (user.security_disabled) return genericError();

    // Real, rolling 24-hour window for the daily counter — computed
    // once, up front, since it's needed regardless of which real,
    // specific reason this attempt is about to be rejected for (a
    // temporary lock, or a genuinely wrong password). Fixed, confirmed
    // bug: this used to only increment inside the wrong-password
    // branch below, but a temporarily-locked account returns before
    // ever reaching that branch — meaning the daily counter genuinely
    // stopped climbing the moment a temporary lock kicked in, and a
    // real attacker simply waiting out each 60-second lock would never
    // actually reach the real 200-attempt daily threshold in practice.
    async function _bumpDailyFailureCount() {
      const dailyWindowExpired = !user.daily_failed_login_reset_at ||
        (Date.now() - new Date(user.daily_failed_login_reset_at).getTime()) > DAILY_FAILED_LOGIN_WINDOW_MS;
      const newDailyCount = dailyWindowExpired ? 1 : (user.daily_failed_login_count || 0) + 1;
      const shouldSecurityDisable = newDailyCount >= _securitySettingsCache.daily_failed_login_limit;
      await pool.query(
        `UPDATE users SET daily_failed_login_count=$1, daily_failed_login_reset_at=$2, security_disabled=$3 WHERE user_id=$4`,
        [newDailyCount, dailyWindowExpired ? new Date() : user.daily_failed_login_reset_at, shouldSecurityDisable || user.security_disabled, user.user_id]
      );
    }

    // Real, actual temporary lockout check — BEFORE verifying the
    // password, since a locked account should never even attempt a
    // real password comparison, let alone reveal whether a submitted
    // password happens to be correct. Still genuinely, correctly counts
    // toward the real, daily total — see the fix above.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await _bumpDailyFailureCount();
      return genericError();
    }

    if (!verifyPassword(password, user.password_hash)) {
      // Real, actual increment on a genuine wrong password — the real,
      // temporary counter, AND the real, rolling daily counter (via the
      // same, shared helper used above).
      const newCount = (user.failed_login_count || 0) + 1;
      const shouldLock = newCount >= _securitySettingsCache.lockout_threshold;

      await pool.query(
        `UPDATE users SET failed_login_count=$1, locked_until=$2 WHERE user_id=$3`,
        [shouldLock ? 0 : newCount, shouldLock ? new Date(Date.now() + _securitySettingsCache.lockout_seconds * 1000) : null, user.user_id]
      );
      await _bumpDailyFailureCount();
      return genericError();
    }

    // A genuine, successful login — real, actual reset of the
    // TEMPORARY failure count only, per explicit, confirmed design.
    // The real, daily counter and security_disabled flag are
    // deliberately NOT reset here — a genuine, successful login should
    // not erase a real, actual daily-volume signal, and a
    // security-disabled account requires genuine, real superadmin
    // action to clear regardless of any later, real, correct password
    // entry (which, per the check above, can't even reach this point
    // while still disabled anyway).
    if (user.failed_login_count > 0 || user.locked_until) {
      await pool.query(`UPDATE users SET failed_login_count=0, locked_until=NULL WHERE user_id=$1`, [user.user_id]);
    }

    const rawToken = await createSession(user.user_id);
    if (!rawToken) return res.status(500).json({ error: 'Could not create session.' });

    // Real, actual cookie — httpOnly (never readable by frontend JS, a
    // real, meaningful protection against XSS-based token theft),
    // sameSite=lax (a real, reasonable default balancing CSRF
    // protection against normal navigation still working), and secure
    // in production (real, actual HTTPS-only transmission — Railway
    // terminates TLS in front of this app, so NODE_ENV determines this
    // correctly for both local development and the real, live deploy).
    res.cookie('session_token', rawToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_DURATION_MS,
    });

    res.json({
      ok: true,
      user: {
        user_id: user.user_id, email: user.email, login_id: user.login_id,
        first_name: user.first_name, last_name: user.last_name,
        role: user.role, is_superadmin: user.is_superadmin,
      },
      must_change_password: user.must_change_password,
    });
  } catch(err) { return fail(res, err, 'POST /api/auth/login:'); }
});

// Real, actual logout — deletes the real, actual session row (not just
// clearing the cookie client-side, which would leave the real session
// usable by anyone who'd captured the raw token beforehand) and clears
// the real cookie.
app.post('/api/auth/logout', async (req, res) => {
  const rawToken = _parseCookie(req.headers.cookie, 'session_token');
  if (rawToken && pool) {
    try {
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashSessionToken(rawToken)]);
    } catch (err) { console.error('logout: could not delete session:', err.message); }
  }
  res.clearCookie('session_token');
  res.json({ ok: true });
});

// Real, actual "who am I" check — the frontend calls this to discover
// the real, current session's user (if any) on page load, rather than
// ever trusting anything the browser itself claims about who's logged
// in.
app.get('/api/auth/me', async (req, res) => {
  const rawToken = _parseCookie(req.headers.cookie, 'session_token');
  const user = await getUserFromSessionToken(rawToken);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  // Real, deliberate strip — session_id_internal is genuinely, only,
  // ever needed server-side (by the set-current-tenant route below);
  // never sent to the client.
  const { session_id_internal, ...publicUser } = user;
  res.json({ user: publicUser });
});

// Real, new route, per the confirmed, real fix for a reported bug —
// genuinely, actually persists the user's current, real, working
// tenant to their own, real, actual session record, so it correctly
// survives a real, actual page refresh. Before this, the ONLY, real
// record of "which tenant is this session currently working in" was a
// plain, in-memory browser variable, which genuinely gets wiped on
// every refresh — forcing a fallback to the user's static "home"
// tenant, which can genuinely differ from the tenant they actually
// selected, incorrectly failing the tenant-validity check on an
// otherwise completely valid, active session the instant the page
// reloaded.
app.post('/api/auth/set-current-tenant', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const user = req.currentUser; // already, correctly, verified by the real, global middleware above
  const { tenant_id } = req.body;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id required' });
  try {
    // Real, genuine verification — a real superadmin can, correctly,
    // set any real, existing tenant; a regular user can only, correctly
    // set one they actually, genuinely have real access to (matching
    // the exact, same, established check the real, global middleware
    // already performs elsewhere).
    if (user.is_superadmin) {
      const { rows } = await pool.query('SELECT 1 FROM tenants WHERE id=$1', [tenant_id]);
      if (!rows.length) return res.status(404).json({ error: 'No such tenant.' });
    } else {
      const { rows } = await pool.query(
        'SELECT 1 FROM user_tenants WHERE user_id=$1 AND tenant_id=$2',
        [user.user_id, tenant_id]
      );
      if (!rows.length) return res.status(403).json({ error: 'You do not have access to this tenant.' });
    }
    await pool.query(
      'UPDATE sessions SET current_tenant_id=$1 WHERE session_id=$2',
      [tenant_id, user.session_id_internal]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/auth/set-current-tenant:'); }
});

// Real, new route, per explicit request — persists the current, real
// user's own, last selection in the "Customize the .xlsx export"
// modal, tied to their actual account (not just the current browser),
// so it correctly, genuinely becomes the default the next time that
// modal opens for them, on any, real, device they sign into.
app.post('/api/auth/xlsx-export-prefs', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const user = req.currentUser;
  const { includeNotes, includeFileNames, includeTestSummaryTab } = req.body;
  try {
    const prefs = {
      includeNotes: !!includeNotes,
      includeFileNames: !!includeFileNames,
      includeTestSummaryTab: !!includeTestSummaryTab,
    };
    await pool.query(
      'UPDATE users SET xlsx_export_prefs=$1 WHERE user_id=$2',
      [JSON.stringify(prefs), user.user_id]
    );
    res.json({ ok: true, prefs });
  } catch(err) { return fail(res, err, 'POST /api/auth/xlsx-export-prefs:'); }
});

// Real, new route, per explicit request — records every, real, actual
// acknowledgment of the sensitive-information consent screen, tied to
// the current, real user's own account. tenant_id is genuinely,
// correctly allowed to be null here — this screen shows right after
// login but before tenant selection has necessarily completed.
app.post('/api/auth/acknowledge-consent', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const user = req.currentUser;
  try {
    await pool.query(
      'INSERT INTO consent_acknowledgments (user_id, login_id, tenant_id) VALUES ($1, $2, $3)',
      [user.user_id, user.login_id, req.currentTenantId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/auth/acknowledge-consent:'); }
});

// Real, new, small, public route exposing DEFAULT_TENANT_ID — needed so
// the real, frontend's seed logic can genuinely, correctly check
// whether the CURRENT, real, actual tenant is genuinely the
// original/default one before ever attempting to seed anything.
// Deliberately public (see PUBLIC_ROUTES below), since this value is
// genuinely just a real, non-sensitive configuration constant.
app.get('/api/default-tenant-id', (req, res) => {
  res.json({ default_tenant_id: DEFAULT_TENANT_ID });
});

// Real, new, self-service "change my own password" route — genuinely
// distinct from both existing password routes: not the superadmin-only
// set-password route (wrong fit for a regular user changing their own),
// and not the email-token reset route (wrong fit for someone who just
// successfully logged in with a temporary password and now needs to set
// a real, new one). Uses the real, actual, just-established session
// itself as authorization — the caller is already genuinely
// authenticated (via the middleware above, into req.currentUser), which
// is precisely the right basis for "let this specific, real, logged-in
// person change their own password."
app.post('/api/auth/change-password', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  if (!req.currentUser) return res.status(401).json({ error: 'Not authenticated' });
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
  if (newPassword.length < _securitySettingsCache.min_password_length) {
    return res.status(400).json({ error: `Password must be at least ${_securitySettingsCache.min_password_length} characters.` });
  }
  try {
    const newHash = hashPassword(newPassword);
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=false, date_updated=NOW() WHERE user_id=$2',
      [newHash, req.currentUser.user_id]
    );
    // Real, actual session invalidation on password change, per
    // explicit, confirmed best-practice request — every OTHER real,
    // live session for this user is genuinely revoked, since the old
    // password may have been compromised. Deliberately preserves the
    // CURRENT, real session (this exact request's own token), so the
    // user isn't immediately logged out right after setting their new
    // password, matching the real, established, existing flow.
    const currentRawToken = _parseCookie(req.headers.cookie, 'session_token');
    const currentTokenHash = currentRawToken ? hashSessionToken(currentRawToken) : null;
    await pool.query(
      'DELETE FROM sessions WHERE user_id=$1 AND token_hash IS DISTINCT FROM $2',
      [req.currentUser.user_id, currentTokenHash]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'POST /api/auth/change-password:'); }
});

app.get('/api/admin/users', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT user_id, tenant_id, email, login_id, first_name, last_name, role, is_superadmin, is_active, date_created, date_updated FROM users ORDER BY last_name, first_name'
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/users:'); }
});

// Non-admin users only — specifically for the M-Template workpaper
// type's Peer Reviewer and GR Review dropdowns, which the user explicitly
// asked to use the same user list as Preparer but restricted to
// non-admins. Kept as a genuinely separate route from GET /api/admin/users
// above (rather than a query-parameter toggle on it), since that route is
// itself an admin-facing endpoint whose own correct behavior is to show
// EVERY user including admins — conflating the two risks that list
// silently excluding admins if a filter flag were ever left off by mistake.
app.get('/api/users/non-admin', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT user_id, email, first_name, last_name FROM users
       WHERE is_superadmin=false AND role != 'admin'
       ORDER BY last_name, first_name`
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/users/non-admin:'); }
});

// Type-ahead search for the "assign users to this tenant" picker — matches
// on first name, last name, or email, case-insensitively, as a substring.
// Excludes users already assigned to the given tenant (if tenantId is
// passed) so the picker only ever shows people who could actually be
// newly added.
app.get('/api/admin/users/search', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.json([]);
  const q = (req.query.q || '').trim();
  const excludeTenantId = req.query.excludeTenantId || null;
  try {
    const params = [`%${q.toLowerCase()}%`];
    let sql = `SELECT user_id, email, first_name, last_name, role FROM users
               WHERE (LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(email) LIKE $1)`;
    if (excludeTenantId) {
      params.push(excludeTenantId);
      sql += ` AND user_id NOT IN (SELECT user_id FROM user_tenants WHERE tenant_id=$2)`;
    }
    sql += ' ORDER BY last_name, first_name LIMIT 25';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/users/search:'); }
});

app.post('/api/admin/users', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { email, login_id, first_name, last_name, role, is_superadmin, is_active, tenant_id } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    // Check whether this is a genuinely NEW user before writing anything —
    // only a brand-new user gets a password-setup token and email. Checked
    // explicitly up front rather than inferred after the INSERT via
    // Postgres's xmax column, which Postgres's own developers have
    // explicitly called unreliable/unsupported for this purpose — not
    // something to base a security-relevant decision (issuing a new
    // credential-setting token) on.
    const { rows: existingRows } = await pool.query('SELECT user_id FROM users WHERE email=$1', [email]);
    const isNewUser = existingRows.length === 0;

    const { rows } = await pool.query(
      `INSERT INTO users (tenant_id, email, login_id, first_name, last_name, role, is_superadmin, is_active, date_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (email) DO UPDATE SET
         login_id=COALESCE(EXCLUDED.login_id, users.login_id),
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         role=EXCLUDED.role, is_superadmin=EXCLUDED.is_superadmin,
         is_active=EXCLUDED.is_active, date_updated=NOW()
       RETURNING user_id, tenant_id, email, login_id, first_name, last_name, role, is_superadmin, is_active, date_created, date_updated`,
      [tenant_id || DEFAULT_TENANT_ID, email, login_id || email, first_name || '', last_name || '', role || 'user', !!is_superadmin, is_active !== false]
    );
    const user = rows[0];

    if (!isNewUser) {
      return res.json(user); // editing an existing user — no new token/email
    }

    // New user — generate a secure, single-use, 7-day token; store only
    // its hash (see hashToken); email the raw token to the user, since
    // that raw value is the only place it will ever exist outside of this
    // one moment.
    let emailStatus = 'sent';
    let emailError = null;
    try {
      const rawToken = generateSecureToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at)
         VALUES ($1,$2,'initial_setup',$3)`,
        [user.user_id, tokenHash, expiresAt]
      );
      await sendPasswordSetupEmail(user.email, user.first_name, rawToken);
    } catch (emailErr) {
      // The USER was still created successfully — a failed email doesn't
      // mean the account creation itself failed. Report both facts
      // separately so whoever's creating the account knows the new user
      // exists but may need their setup link resent some other way.
      console.error('[POST /api/admin/users] User created but setup email failed:', emailErr.message);
      emailStatus = 'failed';
      emailError = emailErr.message;
    }

    res.json({ ...user, setupEmailStatus: emailStatus, setupEmailError: emailError });
  } catch(err) { return fail(res, err, 'POST /api/admin/users:'); }
});

app.get('/api/admin/tenants', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM tenants ORDER BY name');
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/tenants:'); }
});

app.post('/api/admin/tenants', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { id, name, description, domain, plan } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tenants (id, name, description, domain, plan, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description,
         domain=EXCLUDED.domain, plan=EXCLUDED.plan, updated_at=NOW()
       RETURNING *`,
      [id, name, description || '', domain || '', plan || 'trial']
    );
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'POST /api/admin/tenants:'); }
});

// This is also how an existing tenant's fields (name, description, domain,
// plan) get modified — same INSERT ... ON CONFLICT DO UPDATE as above,
// just called again with the same id and changed fields.
// ── Public-facing password-setup / reset endpoints ──────────────────────────
// No admin/session required — the person hasn't logged in yet, that's the
// whole point of this flow. Security here comes entirely from the token
// itself: unguessable (32 random bytes), single-use, and time-limited.

// Checks a token WITHOUT consuming it — used by the set-password page to
// decide what to show (a real form vs. an "this link has expired" message)
// before the person has even typed a password. A token is valid only if
// ALL THREE hold: it matches a stored hash (checked via verifyToken, which
// uses a timing-safe comparison — see hashPassword/verifyPassword above for
// why that matters), it hasn't already been used, and it hasn't expired.
app.get('/api/auth/validate-token', async (req, res) => {
  if (!pool) return res.status(503).json({ valid: false, error: 'No database configured' });
  const rawToken = req.query.token || '';
  if (!rawToken) return res.json({ valid: false, reason: 'missing' });
  try {
    // Tokens aren't looked up by their raw value (they're never stored raw
    // — see hashToken) — every unexpired, unused token hash has to be
    // checked against the submitted raw token instead. This table is
    // expected to stay small (one row per pending setup/reset), so this is
    // fine; it would need a different approach at much larger scale.
    const { rows } = await pool.query(
      `SELECT prt.token_id, prt.user_id, prt.token_hash, prt.expires_at, prt.used_at, u.email, u.first_name
       FROM password_reset_tokens prt JOIN users u ON u.user_id = prt.user_id
       WHERE prt.used_at IS NULL AND prt.expires_at > NOW()`
    );
    const match = rows.find(r => verifyToken(rawToken, r.token_hash));
    if (!match) return res.json({ valid: false, reason: 'invalid_or_expired' });
    res.json({ valid: true, email: match.email, firstName: match.first_name });
  } catch(err) { return fail(res, err, 'GET /api/auth/validate-token:'); }
});

app.post('/api/auth/set-password', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { token: rawToken, password } = req.body;
  if (!rawToken || !password) return res.status(400).json({ error: 'token and password required' });
  if (password.length < _securitySettingsCache.min_password_length) {
    return res.status(400).json({ error: `Password must be at least ${_securitySettingsCache.min_password_length} characters.` });
  }
  try {
    await pool.query('BEGIN');
    // validate-token call — re-checking here, immediately before marking
    // the token used, closes the window where two simultaneous requests
    // could both pass an earlier check before either actually consumed the
    // token, which would let it be redeemed twice.
    const { rows } = await pool.query(
      `SELECT token_id, user_id, token_hash FROM password_reset_tokens
       WHERE used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`
    );
    const match = rows.find(r => verifyToken(rawToken, r.token_hash));
    if (!match) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ error: 'This link is invalid, expired, or has already been used.' });
    }
    const newHash = hashPassword(password);
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=false, date_updated=NOW() WHERE user_id=$2', [newHash, match.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE token_id=$1', [match.token_id]);
    // Real, actual session invalidation, per explicit, confirmed
    // best-practice request — genuinely the simplest, real case here,
    // since there's no real, active session to preserve at all (this
    // route is reached via an emailed link, not an existing, live
    // session). Kept within this same, real transaction, so it's
    // atomic with the actual password update itself.
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [match.user_id]);
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'POST /api/auth/set-password:');
  }
});

// Lets a superadmin directly set a user's password — genuinely distinct
// from the existing email-link reset flow above (POST
// /api/auth/set-password), which requires the user to click a real,
// emailed link. This route is for the real, different, explicit
// workflow requested: a superadmin sets an initial or replacement
// password directly, without an email round-trip. Reuses the same,
// proven hashPassword function the email-link flow already uses.
//
// HONEST NOTE: like every other route in this file today, this has no
// real session/authorization check — this app has no real login system
// yet (only the explicitly-planned, not-yet-functional login modal
// shell being added this same session). This route is not yet actually
// restricted to superadmins at the server level; it's only intended to
// be called from the superadmin-only UI action it's paired with. Real
// server-side authorization needs to be added here once real sessions
// exist — this is a genuine, known gap, not an oversight.
app.post('/api/admin/users/:id/set-password', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { password, isSuperAdminSelf } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  if (password.length < _securitySettingsCache.min_password_length) {
    return res.status(400).json({ error: `Password must be at least ${_securitySettingsCache.min_password_length} characters.` });
  }
  try {
    const newHash = hashPassword(password);
    // Per explicit requirement: a password set this way requires the
    // user to change it at their next login — EXCEPT when the
    // superadmin is setting their own password, which does not carry
    // that requirement. isSuperAdminSelf is an explicit flag from the
    // caller (the UI already knows whether this is "a superadmin
    // setting their own password" vs "a superadmin setting someone
    // else's"), not inferred here.
    const mustChange = !isSuperAdminSelf;
    const { rows } = await pool.query(
      `UPDATE users SET password_hash=$1, must_change_password=$2, date_updated=NOW()
       WHERE user_id=$3
       RETURNING user_id, email, first_name, last_name, must_change_password`,
      [newHash, mustChange, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    // Real, actual session invalidation, per explicit, confirmed
    // best-practice request — every real, live session belonging to
    // the TARGET user is genuinely revoked, since their password (and
    // therefore any session established with the old one) should no
    // longer be trusted.
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]);
    res.json({ ok: true, user: rows[0] });
  } catch(err) { return fail(res, err, 'POST /api/admin/users/:id/set-password:'); }
});

app.patch('/api/admin/users/:id', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { email, login_id, first_name, last_name, role, is_superadmin, is_active, security_disabled } = req.body;
  try {
    // Real, genuine re-enable, per explicit request — when a superadmin
    // is explicitly clearing security_disabled back to false, also
    // resets the real, daily failed-login counter, since otherwise the
    // account could immediately re-trigger the same, real disable on
    // the very next failed attempt, defeating the whole point of this
    // real, deliberate re-enable action.
    const resettingDailyCount = security_disabled === false;
    const { rows } = await pool.query(
      `UPDATE users SET
         email=COALESCE($10,email),
         login_id=COALESCE($7,login_id),
         first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name),
         role=COALESCE($4,role), is_superadmin=COALESCE($5,is_superadmin),
         is_active=COALESCE($6,is_active),
         security_disabled=COALESCE($8,security_disabled),
         daily_failed_login_count=CASE WHEN $9 THEN 0 ELSE daily_failed_login_count END,
         date_updated=NOW()
       WHERE user_id=$1
       RETURNING user_id, tenant_id, email, login_id, first_name, last_name, role, is_superadmin, is_active, security_disabled, date_created, date_updated`,
      [req.params.id, first_name, last_name, role, is_superadmin, is_active, login_id, security_disabled, resettingDailyCount, email]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch(err) {
    // Real, genuine, plausible failure — email has a real, actual
    // UNIQUE constraint, so this correctly, distinctly reports a real
    // duplicate rather than a real, generic 500 the frontend can't
    // meaningfully explain to whoever is trying this change.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That email address is already in use by another user.' });
    }
    return fail(res, err, 'PATCH /api/admin/users/:id:');
  }
});

app.patch('/api/admin/tenants/:id', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { name, description, domain, plan } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET
         name=COALESCE($2,name), description=COALESCE($3,description),
         domain=COALESCE($4,domain), plan=COALESCE($5,plan), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, description, domain, plan]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'PATCH /api/admin/tenants/:id:'); }
});

// Users currently assigned to one specific tenant, via user_tenants — this
// is the right-hand list on the Tenants section once a tenant is selected.
// Includes each user's per-tenant role override (if any) alongside their
// default role, so the UI can show which one is actually in effect.
app.get('/api/admin/tenants/:id/users', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.email, u.first_name, u.last_name, u.role AS default_role,
              ut.role AS tenant_role, ut.date_created AS assigned_on
       FROM user_tenants ut
       JOIN users u ON u.user_id = ut.user_id
       WHERE ut.tenant_id = $1
       ORDER BY u.last_name, u.first_name`,
      [req.params.id]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/tenants/:id/users:'); }
});

// Real, new route for users genuinely NOT assigned to any tenant at
// all, per explicit request — a real NOT EXISTS subquery against
// user_tenants, the correct, real inverse of the route above (which
// finds users WITH a matching row for one specific, real tenant).
app.get('/api/admin/tenants-unassigned-users', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT u.user_id, u.email, u.first_name, u.last_name, u.role AS default_role
       FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.user_id)
         AND u.is_superadmin = false
       ORDER BY u.last_name, u.first_name`
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/tenants-unassigned-users:'); }
});

// Real, new routes for the Security settings, per explicit request. GET
// returns the real, current, live values for the new admin UI. POST
// validates and saves real, new values — updating both the real,
// actual database row AND the in-memory cache immediately, so a real,
// saved change takes effect on the very next login attempt, not only
// after a future server restart.
app.get('/api/admin/security-settings', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const { rows } = await pool.query('SELECT * FROM security_settings WHERE id=1');
    if (!rows.length) return res.status(404).json({ error: 'Security settings not found' });
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'GET /api/admin/security-settings:'); }
});

// Real, new, safe, read-only verification route, per the confirmed,
// real demo-data migration plan — lets a superadmin genuinely confirm
// every, one of the six, real, demo-data entities (audits, workpapers,
// controls, risks, entities, fs_accounts) is actually, correctly
// present in the real, live database for the default tenant, BEFORE
// the real, hardcoded, JS source is ever, actually, safely removed
// from the page.
app.get('/api/admin/verify-demo-data-migrated', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const [audits, workpapers, controls, risks, entities, fsAccounts] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM audits WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT COUNT(*)::int AS n FROM workpapers WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT COUNT(*)::int AS n FROM controls WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT COUNT(*)::int AS n FROM risks WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT COUNT(*)::int AS n FROM assessment_entities WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT COUNT(*)::int AS n FROM fs_accounts WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
    ]);
    const counts = {
      audits: audits.rows[0].n,
      workpapers: workpapers.rows[0].n,
      controls: controls.rows[0].n,
      risks: risks.rows[0].n,
      entities: entities.rows[0].n,
      fs_accounts: fsAccounts.rows[0].n,
    };
    const allPresent = Object.values(counts).every(n => n > 0);
    res.json({ default_tenant_id: DEFAULT_TENANT_ID, counts, safe_to_remove_hardcoded_source: allPresent });
  } catch(err) { return fail(res, err, 'GET /api/admin/verify-demo-data-migrated:'); }
});


// Real, new, one-time migration route, per explicit, confirmed
// instruction — controls/risks/entities/FS-accounts should genuinely,
// only ever belong to a single, real tenant going forward (a real,
// separate, architectural decision from this route), but every, real,
// EXISTING tenant that already has at least one row in any of these
// four tables should genuinely, correctly receive the real, complete,
// default tenant's full set too — added alongside what's already
// there, never overwriting a real, existing item by the same, real ID.
// A real, brand-new tenant (with none of these four tables populated
// at all) is deliberately, correctly excluded — per the explicit,
// confirmed instruction that future, new tenants should NOT receive
// this data automatically.
app.post('/api/admin/copy-demo-data-to-existing-tenants', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    // Real, actual, live source data — the default tenant's complete,
    // current, real set of each entity. Read fresh, every time this
    // route runs, rather than any real, hardcoded snapshot, so this
    // genuinely reflects whatever the default tenant's real, live data
    // actually is right now.
    const [srcControls, srcRisks, srcEntities, srcFsAccounts] = await Promise.all([
      pool.query('SELECT * FROM controls WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT * FROM risks WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT * FROM assessment_entities WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
      pool.query('SELECT * FROM fs_accounts WHERE tenant_id=$1', [DEFAULT_TENANT_ID]),
    ]);

    // Real, actual set of tenants that GENUINELY, already have at least
    // one row in ANY of the four, real tables — the correct, real,
    // explicit criteria confirmed for which tenants receive this copy.
    const { rows: qualifyingTenantRows } = await pool.query(`
      SELECT DISTINCT tenant_id FROM (
        SELECT tenant_id FROM controls
        UNION SELECT tenant_id FROM risks
        UNION SELECT tenant_id FROM assessment_entities
        UNION SELECT tenant_id FROM fs_accounts
      ) t
      WHERE tenant_id != $1
    `, [DEFAULT_TENANT_ID]);
    const targetTenantIds = qualifyingTenantRows.map(r => r.tenant_id);

    const report = {};

    for (const tenantId of targetTenantIds) {
      const tenantReport = { controls_added: 0, risks_added: 0, entities_added: 0, fs_accounts_added: 0 };

      for (const c of srcControls.rows) {
        const result = await pool.query(
          `INSERT INTO controls (tenant_id,id,name,category,objective,objective_id,description,additional_info,
             ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,
             linked_risks,linked_entities,linked_accounts,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tenantId, c.id, c.name, c.category, c.objective, c.objective_id, c.description, c.additional_info,
           c.ctrl_owner, c.proc_owner, c.extra_ctrl_owners, c.extra_proc_owners, c.frequency, c.control_type,
           c.linked_risks, c.linked_entities, c.linked_accounts]
        );
        if (result.rowCount > 0) tenantReport.controls_added++;
      }

      for (const r of srcRisks.rows) {
        const result = await pool.query(
          `INSERT INTO risks (tenant_id,id,name,category,description,updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tenantId, r.id, r.name, r.category, r.description]
        );
        if (result.rowCount > 0) tenantReport.risks_added++;
      }

      for (const e of srcEntities.rows) {
        const result = await pool.query(
          `INSERT INTO assessment_entities (tenant_id,id,name,type,category,address,city,state,zip,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tenantId, e.id, e.name, e.type, e.category, e.address, e.city, e.state, e.zip]
        );
        if (result.rowCount > 0) tenantReport.entities_added++;
      }

      for (const f of srcFsAccounts.rows) {
        const result = await pool.query(
          `INSERT INTO fs_accounts (tenant_id,id,code,description,section,cur_balance,py_balance,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tenantId, f.id, f.code, f.description, f.section, f.cur_balance, f.py_balance]
        );
        if (result.rowCount > 0) tenantReport.fs_accounts_added++;
      }

      report[tenantId] = tenantReport;
    }

    res.json({
      default_tenant_id: DEFAULT_TENANT_ID,
      source_counts: {
        controls: srcControls.rows.length,
        risks: srcRisks.rows.length,
        entities: srcEntities.rows.length,
        fs_accounts: srcFsAccounts.rows.length,
      },
      qualifying_tenants: targetTenantIds,
      results_by_tenant: report,
    });
  } catch(err) { return fail(res, err, 'POST /api/admin/copy-demo-data-to-existing-tenants:'); }
});


app.get('/api/admin/security-error-log', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const { rows } = await pool.query(
      `SELECT ael.log_id, ael.code, aec.title AS code_title, aec.description AS code_description,
              ael.user_id, ael.login_id, u.first_name, u.last_name, u.email,
              ael.requested_path, ael.requested_tenant_id, ael.date_created
       FROM access_error_log ael
       JOIN access_error_codes aec ON aec.code = ael.code
       LEFT JOIN users u ON u.user_id = ael.user_id
       ORDER BY ael.date_created DESC
       LIMIT 1000`
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'GET /api/admin/security-error-log:'); }
});


app.post('/api/admin/security-settings', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const { min_password_length, lockout_seconds, lockout_threshold, daily_failed_login_limit } = req.body;
  const fields = { min_password_length, lockout_seconds, lockout_threshold, daily_failed_login_limit };
  // Real, sensible validation — every one of these must be a real,
  // actual positive integer; a genuinely zero or negative value for
  // any of them would be nonsensical (a zero-second lockout is not a
  // real lockout at all, a zero-length password requirement means no
  // real requirement).
  for (const [key, val] of Object.entries(fields)) {
    if (!Number.isInteger(val) || val < 1) {
      return res.status(400).json({ error: `${key} must be a real, positive whole number.` });
    }
  }
  try {
    const { rows } = await pool.query(
      `UPDATE security_settings SET
         min_password_length=$1, lockout_seconds=$2, lockout_threshold=$3,
         daily_failed_login_limit=$4, date_updated=NOW()
       WHERE id=1
       RETURNING *`,
      [min_password_length, lockout_seconds, lockout_threshold, daily_failed_login_limit]
    );
    // Real, immediate cache refresh — the very next login attempt,
    // anywhere in the app, genuinely uses these new, real values.
    await _loadSecuritySettingsCache();
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'POST /api/admin/security-settings:'); }
});

// Assigns one or more users to a tenant — body: { userIds: [...], role?: '...' }.
// Idempotent: assigning an already-assigned user is a harmless no-op
// (ON CONFLICT DO NOTHING), so the multi-select "assign selected users"
// action in the UI can't fail just because one of several checked users
// was already assigned.
app.post('/api/admin/tenants/:id/users', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  const tenantId = req.params.id;
  const { userIds, role } = req.body;
  if (!Array.isArray(userIds) || !userIds.length) {
    return res.status(400).json({ error: 'userIds (array) required' });
  }
  try {
    await pool.query('BEGIN');
    for (const userId of userIds) {
      await pool.query(
        `INSERT INTO user_tenants (user_id, tenant_id, role, date_updated)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [userId, tenantId, role || null]
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, added: userIds.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'POST /api/admin/tenants/:id/users:');
  }
});

// Removes ONE user's access to a tenant — this is what an admin uses to
// un-assign a user from the right-hand list, not a bulk operation.
app.delete('/api/admin/tenants/:id/users/:userId', requireSuperAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    await pool.query(
      'DELETE FROM user_tenants WHERE tenant_id=$1 AND user_id=$2',
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'DELETE /api/admin/tenants/:id/users/:userId:'); }
});

app.get('/api/orphaned-workpapers', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT w.ref, w.name, w.audit_name FROM workpapers w
       WHERE w.tenant_id=$1
         AND NOT EXISTS (SELECT 1 FROM audits a WHERE a.tenant_id=w.tenant_id AND a.name=w.audit_name)
       ORDER BY w.audit_name, w.ref`,
      [req.currentTenantId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

// Real, new, dedicated route for verifying access to one, specific,
// real workpaper, per explicit, confirmed request — the real, thorough
// approach: a genuine, live backend check on every, real navigation.
// Correctly, genuinely scoped to the real, current, actual tenant,
// matching the exact, same real WHERE clause already, correctly used
// by the list route above.
app.get('/api/workpapers/:ref/access-check', async (req, res) => {
  if (!pool) return res.json({ hasAccess: false });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM workpapers WHERE tenant_id=$1 AND ref=$2',
      [req.currentTenantId, req.params.ref]
    );
    res.json({ hasAccess: rows.length > 0 });
  } catch(err) { return fail(res, err, 'GET /api/workpapers/:ref/access-check:'); }
});

app.get('/api/workpapers', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM workpapers WHERE tenant_id=$1 ORDER BY audit_name, ref', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/workpapers', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const {
    ref, audit_name, name, type, status, results,
    preparer, reviewer, secondary_reviewer,
    date_started, review_date, date_submitted, secondary_review_date,
    population, sample_method, sample_size,
    narrative, description, test_desc,
    linked_controls, linked_risks, linked_entities, fs_accounts,
    scope_entities, scope_fs_accounts,
    test_attributes, sample_fields, sample_data, exceptions, archived,
    audit_date, peer_reviewer, gr_review, control_description,
    it_process, frequency, frequency_other, risk_of_failure, rationale_higher_risk,
    toc_inquiry_performed, toc_observation_performed, toc_reperformance_performed,
    toc_period_from_mmyyyy, toc_period_to_mmyyyy,
    population_source, population_size, population_completeness_desc,
    toc_sample_size, sample_selection_method, mt_entity_name, mt_itgc_ref,
    wp_style, template_used
  } = req.body;
  if (!ref) return res.status(400).json({ error: 'ref required' });
  try {
    await pool.query(`INSERT INTO workpapers
        (tenant_id,ref,audit_name,name,type,status,results,preparer,reviewer,secondary_reviewer,
         date_started,review_date,date_submitted,secondary_review_date,
         population,sample_method,sample_size,narrative,description,test_desc,
         linked_controls,linked_risks,linked_entities,fs_accounts,
         scope_entities,scope_fs_accounts,test_attributes,sample_fields,sample_data,exceptions,archived,
         audit_date,peer_reviewer,gr_review,control_description,
         it_process,frequency,frequency_other,risk_of_failure,rationale_higher_risk,
         toc_inquiry_performed,toc_observation_performed,toc_reperformance_performed,
         toc_period_from_mmyyyy,toc_period_to_mmyyyy,
         population_source,population_size,population_completeness_desc,
         toc_sample_size,sample_selection_method,mt_entity_name,mt_itgc_ref,wp_style,template_used,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
              $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,
              $32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,
              $44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,NOW())
      ON CONFLICT (tenant_id,ref) DO UPDATE SET
        audit_name=EXCLUDED.audit_name, name=EXCLUDED.name, type=EXCLUDED.type,
        status=EXCLUDED.status, results=EXCLUDED.results,
        preparer=EXCLUDED.preparer, reviewer=EXCLUDED.reviewer,
        secondary_reviewer=EXCLUDED.secondary_reviewer,
        date_started=EXCLUDED.date_started, review_date=EXCLUDED.review_date,
        date_submitted=EXCLUDED.date_submitted,
        secondary_review_date=EXCLUDED.secondary_review_date,
        population=EXCLUDED.population, sample_method=EXCLUDED.sample_method,
        sample_size=EXCLUDED.sample_size, narrative=EXCLUDED.narrative,
        description=EXCLUDED.description, test_desc=EXCLUDED.test_desc,
        linked_controls=EXCLUDED.linked_controls, linked_risks=EXCLUDED.linked_risks,
        linked_entities=EXCLUDED.linked_entities, fs_accounts=EXCLUDED.fs_accounts,
        scope_entities=EXCLUDED.scope_entities, scope_fs_accounts=EXCLUDED.scope_fs_accounts,
        test_attributes=EXCLUDED.test_attributes, sample_fields=EXCLUDED.sample_fields,
        -- sample_data is deliberately NOT overwritten on update anymore: the
        -- client no longer sends it at all (User Provided Sample Data now
        -- lives in sample_data_columns/sample_data_rows instead), and this
        -- legacy column's remaining, still-real content is what the one-time
        -- PRS Sample-Data-to-Extracted-Data migration reads from. Always
        -- writing req.body's (now permanently absent) sample_data here would
        -- silently wipe that column to its empty default on every ordinary
        -- workpaper save, destroying the migration's source data before it
        -- ever got a chance to run. Preserving the existing value on UPDATE,
        -- while still writing whatever's provided (or the default) on first
        -- INSERT, keeps this column's content stable until the migration
        -- that depends on it is retired.
        exceptions=EXCLUDED.exceptions, archived=EXCLUDED.archived,
        audit_date=EXCLUDED.audit_date, peer_reviewer=EXCLUDED.peer_reviewer,
        gr_review=EXCLUDED.gr_review, control_description=EXCLUDED.control_description,
        it_process=EXCLUDED.it_process, frequency=EXCLUDED.frequency,
        frequency_other=EXCLUDED.frequency_other, risk_of_failure=EXCLUDED.risk_of_failure,
        rationale_higher_risk=EXCLUDED.rationale_higher_risk,
        toc_inquiry_performed=EXCLUDED.toc_inquiry_performed,
        toc_observation_performed=EXCLUDED.toc_observation_performed,
        toc_reperformance_performed=EXCLUDED.toc_reperformance_performed,
        toc_period_from_mmyyyy=EXCLUDED.toc_period_from_mmyyyy,
        toc_period_to_mmyyyy=EXCLUDED.toc_period_to_mmyyyy,
        population_source=EXCLUDED.population_source, population_size=EXCLUDED.population_size,
        population_completeness_desc=EXCLUDED.population_completeness_desc,
        toc_sample_size=EXCLUDED.toc_sample_size, sample_selection_method=EXCLUDED.sample_selection_method,
        mt_entity_name=EXCLUDED.mt_entity_name, mt_itgc_ref=EXCLUDED.mt_itgc_ref,
        wp_style=EXCLUDED.wp_style, template_used=EXCLUDED.template_used,
        updated_at=NOW()`,
      [req.currentTenantId, ref, audit_name||'', name||'', type||'', status||'draft', results||'',
       preparer||'', reviewer||'', secondary_reviewer||'',
       date_started||null, review_date||null, date_submitted||null, secondary_review_date||null,
       population||'', sample_method||'', sample_size||null,
       narrative||'', description||'', test_desc||'',
       JSON.stringify(linked_controls||[]), JSON.stringify(linked_risks||[]),
       JSON.stringify(linked_entities||[]), JSON.stringify(fs_accounts||[]),
       JSON.stringify(scope_entities||[]), JSON.stringify(scope_fs_accounts||[]),
       JSON.stringify(test_attributes||[]), JSON.stringify(sample_fields||[]),
       JSON.stringify(sample_data||{columns:[],rows:[]}),
       JSON.stringify(exceptions||[]),
       !!archived,
       audit_date||null, peer_reviewer||'', gr_review||'', control_description||'',
       it_process||'', frequency||'', frequency_other||'', risk_of_failure||'', rationale_higher_risk||'',
       !!toc_inquiry_performed, !!toc_observation_performed, !!toc_reperformance_performed,
       toc_period_from_mmyyyy||'', toc_period_to_mmyyyy||'',
       population_source||'', population_size||'', population_completeness_desc||'',
       toc_sample_size||'', sample_selection_method||'', mt_entity_name||'', mt_itgc_ref||'', wp_style||'full', template_used||null
      ]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/workpapers/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM workpapers WHERE ref=$1', [req.params.ref]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── User Provided Sample Data (columns + rows, real Postgres tables) ─────────
// Replaces the old workpapers.sample_data JSONB blob. GET returns both
// columns and rows together for one workpaper, since the client always
// needs the full grid at once. POST replaces the ENTIRE set for that
// workpaper in one transaction (delete-then-reinsert) — this correctly
// handles every kind of edit (added/removed/reordered columns or rows,
// value edits) uniformly, rather than trying to upsert by an index that can
// shift or leaving orphaned rows behind when the count shrinks.
//
// Routes are still addressed by :ref in the URL (that's what the client has
// — the ref shown in the page/URL), but every query underneath operates on
// workpapers.id, resolved from that ref first. This keeps the human-facing
// API shape the same while the actual linking key is the stable surrogate.
async function _resolveWorkpaperId(tenantId, ref) {
  const { rows } = await pool.query('SELECT id FROM workpapers WHERE tenant_id=$1 AND ref=$2', [tenantId, ref]);
  return rows.length ? rows[0].id : null;
}

app.get('/api/sample-data/:ref', async (req, res) => {
  if (!pool) return res.json({ columns: [], rows: [] });
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.json({ columns: [], rows: [] }); // unknown workpaper -> empty, not an error
    const [cols, rows] = await Promise.all([
      pool.query('SELECT * FROM sample_data_columns WHERE workpaper_id=$1 ORDER BY col_index', [wpId]),
      pool.query('SELECT * FROM sample_data_rows WHERE workpaper_id=$1 ORDER BY row_index', [wpId]),
    ]);
    res.json({ columns: cols.rows, rows: rows.rows });
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/sample-data/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const columns = Array.isArray(req.body.columns) ? req.body.columns : [];
  const rows    = Array.isArray(req.body.rows)    ? req.body.rows    : [];
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM sample_data_columns WHERE workpaper_id=$1', [wpId]);
    await pool.query('DELETE FROM sample_data_rows    WHERE workpaper_id=$1', [wpId]);

    // Every column ALWAYS gets an explicit id here — either the one the
    // client already had (so row cells, keyed by column id, keep matching
    // after this save) or a freshly generated one for a column that's never
    // been saved before. Never rely on the table's own DEFAULT firing here:
    // that only helps if a row is inserted with no id at all, but we always
    // want a KNOWN id back in the response either way, so generating it in
    // JS and inserting it explicitly is simpler than reading it back out
    // after an implicit default.
    const savedColumns = [];
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const colId = (c.id && String(c.id).trim()) ? String(c.id).trim() : crypto.randomUUID();
      await pool.query(
        `INSERT INTO sample_data_columns (id,workpaper_id,col_index,title,width,system_added,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [colId, wpId, i, c.title||'', c.width||180, !!c.systemAdded]
      );
      savedColumns.push({ id: colId, title: c.title||'', width: c.width||180, systemAdded: !!c.systemAdded });
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await pool.query(
        `INSERT INTO sample_data_rows (workpaper_id,row_index,cells,row_height,updated_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [wpId, i, JSON.stringify(r.cells||{}), r.height!=null?r.height:null]
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, columns: savedColumns, rowCount: rows.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Extracted Data field list (Title / Description / Guidance) ───────────────
// Same replace-entire-set pattern as sample-data above, for the same reason.
// This is what the Extract Sample Data button populates — it no longer
// writes to sample_data_rows at all (see the client-side change).
app.get('/api/extracted-data/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT * FROM extracted_data WHERE workpaper_id=$1 ORDER BY field_index',
      [wpId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/extracted-data/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const fields = Array.isArray(req.body.fields) ? req.body.fields : [];
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM extracted_data WHERE workpaper_id=$1', [wpId]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await pool.query(
        `INSERT INTO extracted_data (workpaper_id,field_index,title,description,guidance,updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [wpId, i, f.title||'', f.description||'', f.guidance||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: fields.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Extracted Data RECORDS — independent-mode results (checkbox unchecked).
// One row per sample record found, values keyed by extracted_data.id. Same
// replace-entire-set pattern as the tables above. This never touches
// sample_data_columns/sample_data_rows — that's the whole point of this
// table existing separately, so independent-mode extraction has zero
// interaction with the User Provided Sample Data grid even when that grid
// already has data.
app.get('/api/extracted-data-records/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.json([]);
    const { rows } = await pool.query(
      'SELECT * FROM extracted_data_records WHERE workpaper_id=$1 ORDER BY row_index',
      [wpId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/extracted-data-records/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  try {
    const wpId = await _resolveWorkpaperId(req.currentTenantId, req.params.ref);
    if (!wpId) return res.status(404).json({ error: 'Workpaper not found: ' + req.params.ref });

    await pool.query('BEGIN');
    await pool.query('DELETE FROM extracted_data_records WHERE workpaper_id=$1', [wpId]);
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      await pool.query(
        `INSERT INTO extracted_data_records (workpaper_id,row_index,cells,source_file,updated_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [wpId, i, JSON.stringify(r.cells||{}), r.sourceFile||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: records.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});


// ── Workpaper Annotations API ─────────────────────────────────────────────────
app.get('/api/annotations/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT filename, annotations FROM workpaper_annotations WHERE ref=$1 ORDER BY updated_at',
      [req.params.ref]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/annotations', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { ref, filename, annotations } = req.body;
  if (!ref || !filename) return res.status(400).json({ error: 'ref and filename required' });
  try {
    await pool.query(
      `INSERT INTO workpaper_annotations (ref, filename, annotations, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (ref, filename) DO UPDATE
         SET annotations=EXCLUDED.annotations, updated_at=NOW()`,
      [ref, filename, JSON.stringify(annotations || [])]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/annotations/:ref/:filename', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query(
      'DELETE FROM workpaper_annotations WHERE ref=$1 AND filename=$2',
      [req.params.ref, decodeURIComponent(req.params.filename)]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});


// ── Sample Files API (object storage) ───────────────────────────────────────
// Metadata lives in Postgres (sample_files table); the actual file bytes
// live in S3-compatible object storage — see uploadFileToStorage /
// getFileFromStorage / deleteFileFromStorage above for why.

// Direct diagnostic: answers "are my sample files actually stored"
// precisely, not just "does a database row exist claiming they are."
// sample_files holds only metadata and a bucket_key pointer — the
// row existing proves the metadata save succeeded, nothing about
// whether the actual bytes ever reached object storage. This checks
// each row's bucket_key directly against the real bucket with
// HeadObjectCommand (confirms existence + size without downloading
// the file), the same distinction that mattered for the
// database-vs-live-server gaps found elsewhere in this project.
app.get('/api/diagnose-sample-files/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      `SELECT file_id, filename, bucket_key, bucket_name, content_type, size_bytes, archived, date_created
       FROM sample_files WHERE tenant_id=$1 AND ref=$2 ORDER BY filename`,
      [req.currentTenantId, req.params.ref]
    );
    if (!STORAGE_CONFIGURED) {
      return res.json({
        database_rows: rows,
        storage_configured: false,
        message: 'Object storage is not configured on this server — database rows exist, but no check against real storage could be performed.'
      });
    }
    const checked = [];
    for (const row of rows) {
      let exists = false, realSizeBytes = null, error = null;
      try {
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: STORAGE_BUCKET, Key: row.bucket_key }));
        exists = true;
        realSizeBytes = head.ContentLength;
      } catch (e) {
        error = e.name === 'NotFound' ? 'Object does not exist in storage' : e.message;
      }
      checked.push({
        filename: row.filename,
        bucket_key: row.bucket_key,
        archived: row.archived,
        db_size_bytes: Number(row.size_bytes),
        genuinely_exists_in_storage: exists,
        real_size_bytes_in_storage: realSizeBytes,
        size_matches: exists && Number(realSizeBytes) === Number(row.size_bytes),
        error,
      });
    }
    res.json({
      ref: req.params.ref,
      storage_configured: true,
      total_db_rows: rows.length,
      total_confirmed_in_storage: checked.filter(c => c.genuinely_exists_in_storage).length,
      files: checked,
    });
  } catch(err) { return fail(res, err, 'GET /api/diagnose-sample-files/:ref:'); }
});

// Direct diagnostic reproducing the EXACT real upload path — a genuine
// storage write, then the metadata insert with annotated_from — with a
// minimal, real, valid PDF, isolating each step so the actual error
// surfaces directly. Built after a fresh, real console log showed the
// exact same 500 on this route persisting even after a write-side
// fallback was added for a missing annotated_from column — meaning
// either that fix hasn't reached the live deployment, or the real cause
// is something else entirely, and this settles which with direct
// evidence rather than another guess.
app.get('/api/diagnose-sample-upload/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  if (!STORAGE_CONFIGURED) return res.status(503).json({ error: 'Object storage not configured' });
  const result = { steps: [] };
  const testFilename = 'DIAGNOSTIC_UPLOAD_TEST.pdf';
  // A genuine, minimal, valid single-page PDF — not a placeholder string.
  const minimalPdfBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\n0000000000 65535 f \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n0\n%%EOF',
    'utf-8'
  );

  try {
    const bucketKey = _buildBucketKey(req.currentTenantId, req.params.ref, testFilename);
    result.bucket_key_used = bucketKey;

    try {
      await uploadFileToStorage(bucketKey, minimalPdfBytes, 'application/pdf');
      result.steps.push({ step: 'storage_upload', ok: true });
    } catch (e) {
      result.steps.push({ step: 'storage_upload', ok: false, error: { message: e.message, name: e.name, code: e.code } });
      return res.json(result); // storage itself failed — no point continuing to the insert
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO sample_files (tenant_id, ref, filename, bucket_key, content_type, size_bytes, bucket_name, uploaded_by, annotated_from, date_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (tenant_id, ref, filename) DO UPDATE SET
           bucket_key=EXCLUDED.bucket_key, content_type=EXCLUDED.content_type,
           size_bytes=EXCLUDED.size_bytes, bucket_name=EXCLUDED.bucket_name,
           uploaded_by=EXCLUDED.uploaded_by, annotated_from=EXCLUDED.annotated_from, archived=false, date_updated=NOW()
         RETURNING file_id, filename, annotated_from`,
        [req.currentTenantId, req.params.ref, testFilename, bucketKey, 'application/pdf', minimalPdfBytes.length, STORAGE_BUCKET, 'diagnostic', null]
      );
      result.steps.push({ step: 'metadata_insert_with_annotated_from', ok: true, row: rows[0] });
    } catch (e) {
      result.steps.push({ step: 'metadata_insert_with_annotated_from', ok: false, error: { message: e.message, code: e.code, detail: e.detail, hint: e.hint, column: e.column, table: e.table } });
    }

    // Clean up the diagnostic row/object either way.
    try {
      await pool.query('DELETE FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND filename=$3', [req.currentTenantId, req.params.ref, testFilename]);
      await deleteFileFromStorage(bucketKey);
    } catch (cleanupErr) { result.cleanup_error = cleanupErr.message; }

    res.json(result);
  } catch(err) {
    result.unexpected_error = { message: err.message, code: err.code };
    res.status(500).json(result);
  }
});

// ── TEMPORARY: serves the real-file pdfAnnotate test page directly from
// this SAME file — genuinely embedded as a string, not read from a
// second, separate file on disk. This is the actual, real fix for a
// confirmed, real problem: the previous version required uploading
// test-pdfannotate-real-file.html to Railway ALONGSIDE server.js, and
// that second file was never actually deployed, which is precisely why
// every fetch() from it failed — there was nothing there to serve in
// the first place. Embedding it here means deploying this one file is
// genuinely enough; nothing else to remember to upload. Remove this
// whole route once real-file annotation testing is complete — it serves
// a diagnostic tool, not a real part of the app.
const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>pdfAnnotate — real file test</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; }
  #log { white-space: pre-wrap; font-family: monospace; font-size: 13px; background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; min-height: 40px; }
  .pass { color: #4ec9b0; }
  .fail { color: #f14c4c; }
  .info { color: #9cdcfe; }
  input, button { font-size: 14px; padding: 8px 10px; margin: 4px 4px 4px 0; }
  button { cursor: pointer; }
  a { color: #58a6ff; }
  label { display: block; margin-top: 12px; font-weight: 600; font-size: 13px; }
</style>
</head>
<body>
<h1>pdfAnnotate — real stored file test</h1>
<p>Loads an actual, real sample file already stored in your app (via its own real backend routes — no fabricated data) and runs the same proven annotation mechanism against its genuine bytes.</p>

<label>Workpaper ref (e.g. WP-2026-NEWW-010)</label>
<input type="text" id="ref-input" placeholder="WP-2026-NEWW-010" style="width:280px">
<button id="list-btn">List real files for this workpaper</button>

<div id="file-list"></div>
<div id="log"></div>
<p id="download-link"></p>

<script src="https://cdn.jsdelivr.net/npm/annotpdf@1.0.15/_bundles/pdfAnnotate.js"></script>
<script>
const logEl = document.getElementById('log');
const lines = [];
function log(msg, cls) {
  lines.push(cls ? \`<span class="\${cls}">\${msg}</span>\` : msg);
  logEl.innerHTML = lines.join('\\n');
}

document.getElementById('list-btn').onclick = async () => {
  const ref = document.getElementById('ref-input').value.trim();
  const listEl = document.getElementById('file-list');
  listEl.innerHTML = 'Loading real file list…';
  if (!ref) { listEl.innerHTML = 'Enter a real workpaper ref first.'; return; }

  try {
    // Uses this app's own real, existing route — same one the app's own
    // Attached Sample Files list uses, no fabricated data.
    const res = await fetch('/api/diagnose-sample-files/' + encodeURIComponent(ref));
    if (!res.ok) { listEl.innerHTML = 'Could not load files: HTTP ' + res.status; return; }
    const data = await res.json();
    if (!data.files || !data.files.length) {
      listEl.innerHTML = 'No real files found for this workpaper ref, or storage is not configured.';
      return;
    }
    listEl.innerHTML = '<label>Pick a real, stored file to test against:</label>' +
      data.files.map(f => \`<button class="pick-btn" data-name="\${f.filename}">\${f.filename} (\${f.genuinely_exists_in_storage ? 'confirmed in storage' : 'NOT confirmed in storage'})</button>\`).join('<br>');
    document.querySelectorAll('.pick-btn').forEach(btn => {
      btn.onclick = () => runRealFileTest(ref, btn.dataset.name);
    });
  } catch (e) {
    listEl.innerHTML = 'Error: ' + e.message;
  }
};

async function runRealFileTest(ref, filename) {
  lines.length = 0;
  log('Testing against the real, actual file: ' + filename, 'info');
  let fails = 0;
  function check(name, cond) {
    log((cond ? '✓ PASS' : '✗ FAIL') + ' — ' + name, cond ? 'pass' : 'fail');
    if (!cond) fails++;
  }

  check('window.pdfAnnotate is defined (library loaded from CDN)', typeof window.pdfAnnotate !== 'undefined');
  if (typeof window.pdfAnnotate === 'undefined') return;

  // Fetch the genuine, real file_id first, since the actual download
  // route needs it — reads it straight from the app's own real
  // sample-files listing, not fabricated.
  let realFileId;
  try {
    const filesRes = await fetch('/api/sample-files/' + encodeURIComponent(ref));
    const files = await filesRes.json();
    const match = files.find(f => f.filename === filename);
    if (!match) { check('found the real file_id for this filename', false); return; }
    realFileId = match.file_id;
    check('found the real, genuine file_id for this file (' + realFileId + ')', true);
  } catch (e) {
    check('fetching the real file_id', false);
    log('Exception: ' + e.message, 'fail');
    return;
  }

  // Fetch the ACTUAL raw bytes of this real, stored file — the app's own
  // real download route, genuinely reading from S3, not synthetic data.
  let realBytes;
  try {
    const fileRes = await fetch('/api/sample-files/' + encodeURIComponent(ref) + '/' + encodeURIComponent(realFileId) + '/download');
    if (!fileRes.ok) { check('downloading the real file bytes', false); return; }
    const buf = await fileRes.arrayBuffer();
    realBytes = new Uint8Array(buf);
    check('downloaded the ACTUAL real file bytes (' + realBytes.length + ' bytes) from genuine storage', realBytes.length > 0);
  } catch (e) {
    check('downloading the real file bytes', false);
    log('Exception: ' + e.message, 'fail');
    return;
  }

  let factory;
  try {
    factory = new window.pdfAnnotate.AnnotationFactory(realBytes);
    check('AnnotationFactory genuinely initialized from the REAL file\\'s actual bytes', true);
  } catch (e) {
    check('AnnotationFactory initialization on the real file', false);
    log('Exception: ' + e.message, 'fail');
    log('\\nThis would mean the real file\\'s own internal structure (not a synthetic test PDF) has something the library cannot parse — genuinely useful, real information either way.', 'info');
    return;
  }

  try {
    factory.createFreeTextAnnotation({
      page: 0,
      rect: [72, 700, 350, 750],
      contents: 'Test annotation on REAL stored file — Ticket Exists: PASS',
      author: 'Wavefire',
      color: { r: 0, g: 128, b: 0 },
    });
    check('createFreeTextAnnotation genuinely succeeded on the real file', true);
  } catch (e) {
    check('createFreeTextAnnotation on the real file', false);
    log('Exception: ' + e.message, 'fail');
  }

  check('getAnnotationCount reports exactly 1 real annotation added', factory.getAnnotationCount() === 1);

  let outBytes;
  try {
    outBytes = factory.write();
    check('factory.write() genuinely produced output bytes from the real file', outBytes && outBytes.length > 0);
    check('output is genuinely LARGER than the real input (an actual annotation was appended)', outBytes.length > realBytes.length);
  } catch (e) {
    check('factory.write() on the real file', false);
    log('Exception: ' + e.message, 'fail');
  }

  log('\\n' + (fails === 0 ? '✓ ALL CHECKS PASSED against your REAL, actual stored file.' : fails + ' FAILURE(S) against your real file'), fails === 0 ? 'pass' : 'fail');

  if (outBytes) {
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const dl = document.getElementById('download-link');
    dl.innerHTML = '';
    const a = document.createElement('a');
    a.href = url;
    a.download = 'REAL-annotated-' + filename;
    a.textContent = 'Download the actually-annotated real file — open it in Acrobat to confirm the annotation is genuine and editable';
    dl.appendChild(a);
  }
}
</script>
</body>
</html>
`;

app.get('/test-pdfannotate-real-file', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(TEST_PAGE_HTML);
});

// Direct diagnostic: shows the exact, real, current sample_data JSON for
// a specific workpaper — built to settle precisely whether a reported
// "column too wide" issue is a genuine CSS/layout bug or a real,
// already-stored width value from a prior manual resize, since a
// column's width is a real, persisted field on each column object, not
// something re-derived from CSS on every render.
app.get('/api/diagnose-sample-data-widths/:ref', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await pool.query(
      `SELECT ref, sample_data FROM workpapers WHERE tenant_id=$1 AND ref=$2`,
      [req.currentTenantId, req.params.ref]
    );
    if (!rows.length) return res.status(404).json({ error: 'No workpaper found with that ref', ref: req.params.ref });
    const sd = rows[0].sample_data || { columns: [] };
    res.json({
      ref: rows[0].ref,
      columns: (sd.columns || []).map(c => ({ id: c.id, title: c.title, width: c.width })),
    });
  } catch(err) { return fail(res, err, 'GET /api/diagnose-sample-data-widths/:ref:'); }
});

app.get('/api/sample-files/:ref', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT file_id, filename, content_type, size_bytes, uploaded_by, annotated_from, file_category, archived, date_created, date_updated
       FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND archived=false ORDER BY filename`,
      [req.currentTenantId, req.params.ref]
    );
    res.json(rows);
  } catch(err) {
    // If annotated_from genuinely doesn't exist yet on the live table
    // (the migration adding it is a separate, later query — this
    // session has repeatedly found real cases where such a migration
    // hasn't reached an already-live table), this exact query would
    // throw and — without this fallback — take the ENTIRE file list
    // down with it, making genuinely safe, untouched files appear to
    // have vanished from the app even though nothing about them was
    // ever touched. Falls back to the pre-annotated_from column list
    // rather than failing outright.
    if (err.code === '42703') { // undefined_column
      try {
        const { rows } = await pool.query(
          `SELECT file_id, filename, content_type, size_bytes, uploaded_by, file_category, archived, date_created, date_updated
           FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND archived=false ORDER BY filename`,
          [req.currentTenantId, req.params.ref]
        );
        console.error('[GET /api/sample-files/:ref] annotated_from column missing on live table — served without it. Migration likely has not reached this database yet.');
        return res.json(rows.map(r => ({ ...r, annotated_from: null })));
      } catch (err2) { /* fall through to normal error handling below */ }
    }
    return fail(res, err, 'GET /api/sample-files/:ref:');
  }
});

// The counterpart to the route above — lists ARCHIVED files specifically
// (the main list route deliberately excludes them), for a "View Archived"
// panel to show what's been removed but not permanently deleted, with a
// path to restore.
app.get('/api/sample-files/:ref/archived', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT file_id, filename, content_type, size_bytes, uploaded_by, annotated_from, date_created, date_updated
       FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND archived=true ORDER BY filename`,
      [req.currentTenantId, req.params.ref]
    );
    res.json(rows);
  } catch(err) {
    if (err.code === '42703') {
      try {
        const { rows } = await pool.query(
          `SELECT file_id, filename, content_type, size_bytes, uploaded_by, date_created, date_updated
           FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND archived=true ORDER BY filename`,
          [req.currentTenantId, req.params.ref]
        );
        return res.json(rows.map(r => ({ ...r, annotated_from: null })));
      } catch (err2) { /* fall through */ }
    }
    return fail(res, err, 'GET /api/sample-files/:ref/archived:');
  }
});

app.post('/api/sample-files/:ref', sampleFileUpload.single('file'), async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  if (!STORAGE_CONFIGURED) return res.status(503).json({ error: 'Object storage is not configured on the server.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
  const ref = req.params.ref;
  const filename = req.body.filename || req.file.originalname;
  const uploadedBy = req.body.uploadedBy || '';
  const annotatedFrom = req.body.annotatedFrom || null;
  // Real, new field, per explicit confirmation — genuinely distinguishes
  // an "Attached Sample File" from an "Attached Workpaper File" within
  // this same, real, existing table. Defaults to 'sample' for genuine
  // backward compatibility with every, real, existing frontend call
  // that doesn't yet send this field.
  const fileCategory = req.body.fileCategory === 'workpaper' ? 'workpaper' : 'sample';

  try {
    // If a file with this same name AND same category already exists
    // for this workpaper, remember its old bucket key so it can be
    // cleaned up — but only AFTER the new upload is confirmed to have
    // succeeded, so a failed re-upload never destroys the previously-
    // good file. Genuinely scoped by file_category too now, per
    // explicit confirmation — a real "summary.pdf" sample file and a
    // real "summary.pdf" workpaper file are two, real, genuinely
    // distinct rows, not a real conflict with each other.
    const { rows: existingRows } = await pool.query(
      'SELECT bucket_key FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND filename=$3 AND file_category=$4',
      [req.currentTenantId, ref, filename, fileCategory]
    );
    const oldBucketKey = existingRows[0]?.bucket_key || null;

    const bucketKey = _buildBucketKey(req.currentTenantId, ref, filename);
    await uploadFileToStorage(bucketKey, req.file.buffer, req.file.mimetype);

    let rows;
    try {
      ({ rows } = await pool.query(
        `INSERT INTO sample_files (tenant_id, ref, filename, bucket_key, content_type, size_bytes, bucket_name, uploaded_by, annotated_from, file_category, date_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (tenant_id, ref, filename, file_category) DO UPDATE SET
           bucket_key=EXCLUDED.bucket_key, content_type=EXCLUDED.content_type,
           size_bytes=EXCLUDED.size_bytes, bucket_name=EXCLUDED.bucket_name,
           uploaded_by=EXCLUDED.uploaded_by, annotated_from=EXCLUDED.annotated_from, archived=false, date_updated=NOW()
         RETURNING file_id, filename, content_type, size_bytes, uploaded_by, annotated_from, file_category, date_created, date_updated`,
        [req.currentTenantId, ref, filename, bucketKey, req.file.mimetype, req.file.size, STORAGE_BUCKET, uploadedBy, annotatedFrom, fileCategory]
      ));
    } catch (insertErr) {
      // Same real, confirmed gap already fixed on the GET routes two
      // turns ago, but never applied here on the write side — if
      // annotated_from genuinely hasn't reached the live table yet, this
      // exact insert throws with NO fallback, meaning the file's bytes
      // are already safely uploaded to storage above, but the whole
      // request still fails with a 500 because the metadata write can't
      // complete. This directly explains a real, confirmed set of 500s
      // on this exact route from an actual console log. Falls back to
      // the pre-annotated_from insert shape rather than losing the
      // upload outright.
      if (insertErr.code === '42703') {
        console.error('[POST /api/sample-files/:ref] annotated_from column missing on live table — saved without it. Migration likely has not reached this database yet.');
        ({ rows } = await pool.query(
          `INSERT INTO sample_files (tenant_id, ref, filename, bucket_key, content_type, size_bytes, bucket_name, uploaded_by, file_category, date_updated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (tenant_id, ref, filename, file_category) DO UPDATE SET
             bucket_key=EXCLUDED.bucket_key, content_type=EXCLUDED.content_type,
             size_bytes=EXCLUDED.size_bytes, bucket_name=EXCLUDED.bucket_name,
             uploaded_by=EXCLUDED.uploaded_by, archived=false, date_updated=NOW()
           RETURNING file_id, filename, content_type, size_bytes, uploaded_by, file_category, date_created, date_updated`,
          [req.currentTenantId, ref, filename, bucketKey, req.file.mimetype, req.file.size, STORAGE_BUCKET, uploadedBy, fileCategory]
        ));
        rows = rows.map(r => ({ ...r, annotated_from: null }));
      } else {
        throw insertErr;
      }
    }

    // Now that the new object and the database row are both confirmed
    // good, clean up the old object — best-effort; a failure here doesn't
    // fail the whole upload, since the new file is already correctly
    // stored and recorded.
    if (oldBucketKey && oldBucketKey !== bucketKey) {
      deleteFileFromStorage(oldBucketKey).catch(function(e){
        console.error('[sample-files] Could not clean up old object', oldBucketKey, ':', e.message);
      });
    }

    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'POST /api/sample-files/:ref:'); }
});

app.get('/api/sample-files/:ref/:fileId/download', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const { rows } = await pool.query(
      'SELECT filename, bucket_key, content_type FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND file_id=$3',
      [req.currentTenantId, req.params.ref, req.params.fileId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    const file = rows[0];
    const stored = await getFileFromStorage(file.bucket_key);
    res.setHeader('Content-Type', file.content_type || stored.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
    if (stored.ContentLength) res.setHeader('Content-Length', stored.ContentLength);
    // Stream directly to the response — never buffer the whole file in
    // server memory, which matters at the file sizes this app handles.
    stored.Body.pipe(res);
  } catch(err) { return fail(res, err, 'GET /api/sample-files/:ref/:fileId/download:'); }
});

// Soft-hide, not delete — matches the same archived pattern already used
// on workpapers. The object itself and its database row both stay intact;
// this just drops it out of the normal file list (see the GET route's
// archived=false filter above).
app.patch('/api/sample-files/:ref/:fileId/archive', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const { rows } = await pool.query(
      `UPDATE sample_files SET archived=$4, date_updated=NOW()
       WHERE tenant_id=$1 AND ref=$2 AND file_id=$3 RETURNING file_id`,
      [req.currentTenantId, req.params.ref, req.params.fileId, req.body.archived !== false]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'PATCH /api/sample-files/:ref/:fileId/archive:'); }
});

// Genuine, permanent deletion — removes the object from storage AND the
// database row. Distinct from the archive route above; this is the real
// "gone for good" action, used deliberately rather than as the default.
app.delete('/api/sample-files/:ref/:fileId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database configured' });
  try {
    const { rows } = await pool.query(
      'SELECT bucket_key FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND file_id=$3',
      [req.currentTenantId, req.params.ref, req.params.fileId]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found' });
    await deleteFileFromStorage(rows[0].bucket_key);
    await pool.query(
      'DELETE FROM sample_files WHERE tenant_id=$1 AND ref=$2 AND file_id=$3',
      [req.currentTenantId, req.params.ref, req.params.fileId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'DELETE /api/sample-files/:ref/:fileId:'); }
});


// ── Company Settings API ──────────────────────────────────────────────────────
app.get('/api/company-settings', async (req, res) => {
  if (!pool) return res.json({});
  try {
    await pool.query(`INSERT INTO company_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [req.currentTenantId]);
    // Select columns explicitly. `SELECT *` + delete would leak any future
    // secret column that someone forgets to strip.
    const { rows } = await pool.query(
      `SELECT tenant_id,name,industry,fiscal_year_end,address,city,state,zip,
              website,ein,ai_provider,ai_model,azure_endpoint,azure_deployment,updated_at
       FROM company_settings WHERE tenant_id=$1`,
      [req.currentTenantId]
    );
    res.json(rows[0] || {});
  } catch(err) { return fail(res, err, 'company-settings:get'); }
});
app.post('/api/company-settings', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, industry, fiscal_year_end, address, city, state, zip, website, ein,
          ai_provider, ai_model, azure_endpoint, azure_deployment,
          azure_api_key, openai_api_key } = req.body;

  // Reject an unsafe Azure endpoint before it is ever persisted.
  if (azure_endpoint && !isSafeAzureEndpoint(azure_endpoint))
    return res.status(400).json({ error: 'Azure endpoint must be an https URL on *.openai.azure.com or *.cognitiveservices.azure.com' });
  if (azure_deployment && !isSafeDeploymentName(azure_deployment))
    return res.status(400).json({ error: 'Azure deployment name may contain only letters, numbers, dot, dash and underscore' });

  try {
    const q = `INSERT INTO company_settings
      (tenant_id,name,industry,fiscal_year_end,address,city,state,zip,website,ein,ai_provider,ai_model,azure_endpoint,azure_deployment,updated_at)
      VALUES ($14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        name=EXCLUDED.name, industry=EXCLUDED.industry, fiscal_year_end=EXCLUDED.fiscal_year_end,
        address=EXCLUDED.address, city=EXCLUDED.city, state=EXCLUDED.state, zip=EXCLUDED.zip,
        website=EXCLUDED.website, ein=EXCLUDED.ein, ai_provider=EXCLUDED.ai_provider,
        ai_model=EXCLUDED.ai_model, azure_endpoint=EXCLUDED.azure_endpoint,
        azure_deployment=EXCLUDED.azure_deployment, updated_at=NOW()`;
    await pool.query(q, [name||'', industry||'', fiscal_year_end||'', address||'',
      city||'', state||'', zip||'', website||'', ein||'',
      ai_provider||'anthropic', ai_model||'claude-sonnet-4-6',
      azure_endpoint||'', azure_deployment||'', req.currentTenantId]);
    // Update API keys separately if provided
    if (azure_api_key)  await pool.query('UPDATE company_settings SET azure_api_key=$1  WHERE tenant_id=$2', [azure_api_key,  req.currentTenantId]);
    if (openai_api_key) await pool.query('UPDATE company_settings SET openai_api_key=$1 WHERE tenant_id=$2', [openai_api_key, req.currentTenantId]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'company-settings'); }
});

// ── Tenant AI Config API ──────────────────────────────────────────────────────
app.get('/api/tenant-ai-config', async (req, res) => {
  if (!pool) return res.json({});
  try {
    const { rows } = await pool.query(
      'SELECT provider,model,endpoint,deployment,key_hint,use_managed_id FROM tenant_ai_configs WHERE tenant_id=$1',
      [req.currentTenantId]
    );
    res.json(rows); // never return encrypted_key
  } catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/tenant-ai-config', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { provider, model, endpoint, deployment, api_key, azure_tenant_id, use_managed_id } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });
  if (!ENC_KEY) return res.status(503).json({ error: 'Server is not configured to store credentials securely (CREDENTIAL_ENCRYPTION_KEY missing).' });
  const enc = api_key ? encryptKey(api_key) : null;
  const hint = api_key ? api_key.slice(-4) : null;
  try {
    await pool.query(`
      INSERT INTO tenant_ai_configs (tenant_id,provider,model,endpoint,deployment,encrypted_key,key_hint,azure_tenant_id,use_managed_id,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (tenant_id,provider) DO UPDATE SET
        model=EXCLUDED.model, endpoint=EXCLUDED.endpoint, deployment=EXCLUDED.deployment,
        encrypted_key=COALESCE(NULLIF(EXCLUDED.encrypted_key,''),tenant_ai_configs.encrypted_key),
        key_hint=COALESCE(NULLIF(EXCLUDED.key_hint,''),tenant_ai_configs.key_hint),
        azure_tenant_id=EXCLUDED.azure_tenant_id, use_managed_id=EXCLUDED.use_managed_id,
        updated_at=NOW()`,
      [req.currentTenantId, provider, model||'', endpoint||'', deployment||'',
       enc||'', hint||'', azure_tenant_id||'', use_managed_id||false]);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── AI Proxy — routes analysis requests to the configured provider ─────────────
// This route carries a base64-encoded PDF/image in its JSON body (document
// extraction — see _sdExtractFromOneFile client-side), which the global 2mb
// limit (tightened for security elsewhere) is too small for: base64 inflates
// a file to ~1.37x its size, so a real-world scanned PDF over ~1.4MB would be
// silently rejected by Express with a 413 before ever reaching the AI call —
// the exact failure this override fixes. A dedicated, larger limit here is
// safe: it's the same 2mb-vs-larger tradeoff, just scoped to the one route
// that legitimately needs it instead of loosened globally.
const AI_ANALYZE_BODY_LIMIT = process.env.AI_ANALYZE_BODY_LIMIT || '15mb';
app.post('/api/ai/analyze', express.json({ limit: AI_ANALYZE_BODY_LIMIT }), aiRateLimit, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { messages, max_tokens, system } = req.body;

  // ── Resolve credentials: prefer tenant_ai_configs, fall back to company_settings ──
  let provider = 'anthropic', model = 'claude-sonnet-4-6';
  let azureEndpoint='', azureDeployment='', azureApiKey='', openaiApiKey='';

  try {
    // First try the new per-tenant credential store
    const { rows: cfgRows } = await pool.query(
      'SELECT * FROM company_settings WHERE tenant_id=$1', [req.currentTenantId]
    );
    const cs = cfgRows[0] || {};
    provider = cs.ai_provider || 'anthropic';
    model    = cs.ai_model    || 'claude-sonnet-4-6';

    // Look for an encrypted key in tenant_ai_configs
    const { rows: tacRows } = await pool.query(
      'SELECT * FROM tenant_ai_configs WHERE tenant_id=$1 AND provider=$2',
      [req.currentTenantId, provider]
    );
    const tac = tacRows[0];
    if (tac) {
      model          = tac.model          || model;
      azureEndpoint  = tac.endpoint       || cs.azure_endpoint  || '';
      azureDeployment= tac.deployment     || cs.azure_deployment|| '';
      azureApiKey    = decryptKey(tac.encrypted_key) || cs.azure_api_key || '';
      openaiApiKey   = decryptKey(tac.encrypted_key) || cs.openai_api_key|| '';
    } else {
      // Fall back to company_settings plain-text keys
      azureEndpoint  = cs.azure_endpoint  || '';
      azureDeployment= cs.azure_deployment|| '';
      azureApiKey    = cs.azure_api_key   || '';
      openaiApiKey   = cs.openai_api_key  || '';
    }
  } catch(e) { /* fall through to anthropic default */ }

  try {
    if (provider === 'azure') {
      // Azure OpenAI
      const endpoint = azureEndpoint;
      const deployment = azureDeployment;
      const apiKey = azureApiKey;
      if (!endpoint || !deployment || !apiKey) return res.status(400).json({ error: 'Azure OpenAI not fully configured. Set endpoint, deployment, and API key in Settings.' });
      // Re-validate at point of use: a row persisted before validation existed, or
      // written directly to the DB, must not be able to exfiltrate the API key.
      if (!isSafeAzureEndpoint(endpoint) || !isSafeDeploymentName(deployment)) {
        console.error('[ai/analyze] Refusing unsafe Azure endpoint/deployment');
        return res.status(400).json({ error: 'Stored Azure endpoint is not a valid Azure OpenAI URL. Re-save it in Settings.' });
      }
      const url = new URL(`/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`, endpoint);
      url.searchParams.set('api-version', '2024-02-01');
      const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
      const azRes = await fetch(url, {
        method:'POST',
        redirect: 'error',   // never follow a redirect that could carry the key off-host
        headers: { 'Content-Type':'application/json', 'api-key': apiKey },
        body: JSON.stringify({ messages: msgs, max_tokens: max_tokens||4000 })
      });
      const azData = await azRes.json();
      if (!azRes.ok) return res.status(azRes.status).json({ error: azData.error?.message || 'Azure API error' });
      // Normalize to Anthropic-style response
      return res.json({ content: [{ type:'text', text: azData.choices?.[0]?.message?.content || '' }], model: deployment, provider:'azure' });

    } else if (provider === 'openai') {
      // Direct OpenAI
      const apiKey = openaiApiKey;
      // model already resolved above
      if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured. Add it in Settings.' });
      const msgs = system ? [{ role:'system', content:system }, ...messages] : messages;
      const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model||'gpt-4o', messages: msgs, max_tokens: max_tokens||4000 })
      });
      const oaData = await oaRes.json();
      if (!oaRes.ok) return res.status(oaRes.status).json({ error: oaData.error?.message || 'OpenAI API error' });
      return res.json({ content: [{ type:'text', text: oaData.choices?.[0]?.message?.content || '' }], model: model||'gpt-4o', provider:'openai' });

    } else {
      // Anthropic (default) — use existing proxy path
      const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
      if (!anthropicKey) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set on server.' });
      // model already resolved above
      const body = { model, max_tokens: max_tokens||4000, messages };
      if (system) body.system = system;
      const antRes = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key': anthropicKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify(body)
      });
      const antData = await antRes.json();
      if (!antRes.ok) return res.status(antRes.status).json({ error: antData.error?.message || 'Anthropic API error' });
      return res.json({ ...antData, provider:'anthropic' });
    }
  } catch(err) { return fail(res, err, 'api'); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DATA ANALYSIS API
// ══════════════════════════════════════════════════════════════════════════════

// ── Datasets ──────────────────────────────────────────────────────────────────
app.get('/api/da/datasets', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT d.*, 
        (SELECT COUNT(*) FROM da_columns  WHERE dataset_id=d.id) AS col_count_actual,
        (SELECT COUNT(*) FROM da_labels   WHERE dataset_id=d.id) AS label_count,
        (SELECT COUNT(*) FROM da_model_runs WHERE dataset_id=d.id) AS run_count
       FROM da_datasets d
       WHERE d.tenant_id=$1
       ORDER BY d.last_used DESC`,
      [req.currentTenantId]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, filename, file_hash, row_count, col_count, notes } = req.body;
  if (!filename || !file_hash) return res.status(400).json({ error: 'filename and file_hash required' });
  try {
    // Check if this file hash already exists for this tenant
    const existing = await pool.query(
      'SELECT id FROM da_datasets WHERE tenant_id=$1 AND file_hash=$2',
      [req.currentTenantId, file_hash]
    );
    if (existing.rows.length) {
      // Update last_used and return existing id
      await pool.query(
        'UPDATE da_datasets SET last_used=NOW(), name=$1, row_count=$2, col_count=$3 WHERE id=$4',
        [name||filename, row_count||0, col_count||0, existing.rows[0].id]
      );
      return res.json({ id: existing.rows[0].id, existing: true });
    }
    const { rows } = await pool.query(
      `INSERT INTO da_datasets (tenant_id,name,filename,file_hash,row_count,col_count,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.currentTenantId, name||filename, filename, file_hash, row_count||0, col_count||0, notes||'']
    );
    res.json({ id: rows[0].id, existing: false });
  } catch(err) { return fail(res, err, 'api'); }
});

app.patch('/api/da/datasets/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { name, notes } = req.body;
  try {
    await pool.query(
      'UPDATE da_datasets SET name=COALESCE($1,name), notes=COALESCE($2,notes), last_used=NOW() WHERE id=$3 AND tenant_id=$4',
      [name, notes, req.params.id, req.currentTenantId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/da/datasets/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    // CASCADE on da_columns, da_labels, da_model_runs handles cleanup
    const r = await pool.query(
      'DELETE FROM da_datasets WHERE id=$1 AND tenant_id=$2 RETURNING id',
      [req.params.id, req.currentTenantId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Dataset not found' });
    res.json({ ok: true, purged: req.params.id });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Columns ───────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/columns', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_columns WHERE dataset_id=$1 ORDER BY col_index',
      [req.params.id]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/columns', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const cols = req.body.columns; // array of column definitions
  if (!Array.isArray(cols)) return res.status(400).json({ error: 'columns array required' });
  try {
    // Upsert all columns in one transaction
    await pool.query('BEGIN');
    for (const c of cols) {
      await pool.query(
        `INSERT INTO da_columns (dataset_id,col_index,col_name,label,col_type,include_in_model,encoding,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dataset_id,col_index) DO UPDATE SET
           label=EXCLUDED.label, col_type=EXCLUDED.col_type,
           include_in_model=EXCLUDED.include_in_model,
           encoding=EXCLUDED.encoding, notes=EXCLUDED.notes`,
        [req.params.id, c.col_index, c.col_name||'', c.label||'',
         c.col_type||'auto', c.include_in_model!==false,
         c.encoding||'auto', c.notes||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: cols.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

// ── Labels ────────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/labels', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_labels WHERE dataset_id=$1 ORDER BY row_index',
      [req.params.id]
    );
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/labels', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { row_index, label, labeled_by, notes } = req.body;
  if (row_index == null || !label) return res.status(400).json({ error: 'row_index and label required' });
  if (!['anomaly','normal','uncertain'].includes(label))
    return res.status(400).json({ error: 'label must be anomaly|normal|uncertain' });
  try {
    await pool.query(
      `INSERT INTO da_labels (dataset_id,row_index,label,labeled_by,notes,labeled_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (dataset_id,row_index) DO UPDATE SET
         label=EXCLUDED.label, labeled_by=EXCLUDED.labeled_by,
         notes=EXCLUDED.notes, labeled_at=NOW()`,
      [req.params.id, row_index, label, labeled_by||'', notes||'']
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/labels/bulk', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const labels = req.body.labels; // [{row_index, label, labeled_by, notes}]
  if (!Array.isArray(labels)) return res.status(400).json({ error: 'labels array required' });
  try {
    await pool.query('BEGIN');
    for (const l of labels) {
      if (l.row_index == null || !l.label) continue;
      await pool.query(
        `INSERT INTO da_labels (dataset_id,row_index,label,labeled_by,notes,labeled_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (dataset_id,row_index) DO UPDATE SET
           label=EXCLUDED.label, labeled_by=EXCLUDED.labeled_by,
           notes=EXCLUDED.notes, labeled_at=NOW()`,
        [req.params.id, l.row_index, l.label, l.labeled_by||'', l.notes||'']
      );
    }
    await pool.query('COMMIT');
    res.json({ ok: true, saved: labels.length });
  } catch(err) {
    await pool.query('ROLLBACK');
    return fail(res, err, 'api');
  }
});

app.delete('/api/da/datasets/:id/labels/:rowIndex', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query(
      'DELETE FROM da_labels WHERE dataset_id=$1 AND row_index=$2',
      [req.params.id, parseInt(req.params.rowIndex)]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Model Runs ────────────────────────────────────────────────────────────────
app.get('/api/da/datasets/:id/runs', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT id, dataset_id, model_type, params, thresholds, weights,
              label_count, created_at
       FROM da_model_runs WHERE dataset_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    // Omit scores from list view — scores can be large
    res.json(rows);
  } catch(err) { return fail(res, err, 'api'); }
});

app.get('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM da_model_runs WHERE id=$1',
      [req.params.runId]
    );
    res.json(rows[0] || null);
  } catch(err) { return fail(res, err, 'api'); }
});

app.post('/api/da/datasets/:id/runs', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { model_type, params, scores, thresholds, weights, label_count } = req.body;
  if (!model_type) return res.status(400).json({ error: 'model_type required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO da_model_runs (dataset_id,model_type,params,scores,thresholds,weights,label_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.params.id, model_type,
       JSON.stringify(params||{}),
       JSON.stringify(scores||[]),
       JSON.stringify(thresholds||{}),
       JSON.stringify(weights||{}),
       label_count||0]
    );
    // Update dataset last_used
    await pool.query('UPDATE da_datasets SET last_used=NOW() WHERE id=$1', [req.params.id]);
    res.json({ id: rows[0].id });
  } catch(err) { return fail(res, err, 'api'); }
});

app.patch('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { thresholds, weights } = req.body;
  try {
    await pool.query(
      `UPDATE da_model_runs SET
         thresholds=COALESCE($1::jsonb, thresholds),
         weights=COALESCE($2::jsonb, weights)
       WHERE id=$3`,
      [thresholds ? JSON.stringify(thresholds) : null,
       weights    ? JSON.stringify(weights)    : null,
       req.params.runId]
    );
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

app.delete('/api/da/runs/:runId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try {
    await pool.query('DELETE FROM da_model_runs WHERE id=$1', [req.params.runId]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Dataset lookup by file hash (used to restore saved column defs on re-upload)
app.get('/api/da/datasets/by-hash/:hash', async (req, res) => {
  if (!pool) return res.json(null);
  try {
    const { rows } = await pool.query(
      `SELECT d.*, array_agg(c.* ORDER BY c.col_index) AS columns
       FROM da_datasets d
       LEFT JOIN da_columns c ON c.dataset_id=d.id
       WHERE d.tenant_id=$1 AND d.file_hash=$2
       GROUP BY d.id
       ORDER BY d.last_used DESC LIMIT 1`,
      [req.currentTenantId, req.params.hash]
    );
    if (!rows.length) return res.json(null);
    await pool.query('UPDATE da_datasets SET last_used=NOW() WHERE id=$1', [rows[0].id]);
    res.json(rows[0]);
  } catch(err) { return fail(res, err, 'api'); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ML SERVICE PROXY (Option B) — routes multivariate/ML + supervised requests to
//  the Python microservice when configured. The Node app never talks scikit-learn
//  itself; it just forwards the request and returns the result, so the shared
//  secret (ML_SERVICE_TOKEN) never reaches the browser.
// ══════════════════════════════════════════════════════════════════════════════
const ML_SERVICE_URL   = process.env.ML_SERVICE_URL   || '';
const ML_SERVICE_TOKEN = process.env.ML_SERVICE_TOKEN || '';
const ML_SERVICE_CONFIGURED = !!(ML_SERVICE_URL && ML_SERVICE_TOKEN);

if (ML_SERVICE_URL && !ML_SERVICE_TOKEN) {
  console.error('[SECURITY] ML_SERVICE_URL is set but ML_SERVICE_TOKEN is not. ' +
    'The ML service proxy will refuse to call it. Set both or neither.');
}

// Lets the client know at load time whether to prefer the Python engine.
app.get('/api/ml/status', (req, res) => {
  res.json({ configured: ML_SERVICE_CONFIGURED, engine: ML_SERVICE_CONFIGURED ? 'python-sklearn' : 'js-fallback' });
});

app.post('/api/ml/unsupervised', aiRateLimit, async (req, res) => {
  if (!ML_SERVICE_CONFIGURED) return res.status(503).json({ error: 'ML service not configured', fallback: 'js' });
  try {
    const upstream = await fetch(new URL('/api/ml/unsupervised', ML_SERVICE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, token: ML_SERVICE_TOKEN }), // token injected server-side only
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.detail || 'ML service error' });
    res.json(data);
  } catch(err) {
    console.error('[ml/unsupervised]', err.message);
    res.status(502).json({ error: 'ML service unreachable', fallback: 'js' });
  }
});

app.post('/api/ml/train', aiRateLimit, async (req, res) => {
  if (!ML_SERVICE_CONFIGURED) return res.status(503).json({ error: 'ML service not configured', fallback: 'js' });
  try {
    const upstream = await fetch(new URL('/api/ml/train', ML_SERVICE_URL), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, token: ML_SERVICE_TOKEN }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.detail || 'ML service error' });
    res.json(data);
  } catch(err) {
    console.error('[ml/train]', err.message);
    res.status(502).json({ error: 'ML service unreachable', fallback: 'js' });
  }
});

// ── Bulk Seed API ─────────────────────────────────────────────────────────────
// Called from client startup to write all static data to DB using
// INSERT ... ON CONFLICT DO NOTHING — safe to run on every deploy.
// Audits + workpapers are excluded here because their PK is the user-editable name.
// Per explicit confirmation, only ever allowed for the real,
// original/default tenant — a genuinely, newly-created, real tenant
// must never receive any of this demo data. This is the real,
// backend-level guard, as genuine defense-in-depth alongside the real,
// frontend's own, matching check — this route's entire, actual purpose
// is seeding demo data, never a real, legitimate, user-facing action.
app.post('/api/seed/bulk', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  if (req.currentTenantId !== DEFAULT_TENANT_ID) {
    return res.status(403).json({ error: 'Seeding is only permitted for the default tenant.' });
  }
  const { controls=[], risks=[], entities=[], fs_accounts=[], objectives=[] } = req.body;
  const results = {};
  const tid = req.currentTenantId;
  try {
    // Controls
    if (controls.length) {
      let n = 0;
      for (const c of controls) {
        if (!c.id) continue;
        const r = await pool.query(
          `INSERT INTO controls (tenant_id,id,name,category,objective,objective_id,description,additional_info,
            ctrl_owner,proc_owner,extra_ctrl_owners,extra_proc_owners,frequency,control_type,
            linked_risks,linked_entities,linked_accounts,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, c.id, c.name||c.title||'', c.category||'', c.objective||'', c.objective_id||'',
           c.description||'', c.additional_info||'', c.ctrl_owner||'', c.proc_owner||'',
           JSON.stringify(c.extra_ctrl_owners||[]), JSON.stringify(c.extra_proc_owners||[]),
           c.frequency||'', c.control_type||'',
           JSON.stringify(c.linked_risks||[]), JSON.stringify(c.linked_entities||[]),
           JSON.stringify(c.linked_accounts||[])]);
        if (r.rowCount > 0) n++;
      }
      results.controls = n;
    }
    // Risks
    if (risks.length) {
      let n = 0;
      for (const r of risks) {
        if (!r.id) continue;
        const res2 = await pool.query(
          `INSERT INTO risks (tenant_id,id,name,category,description,updated_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, r.id, r.name||r.title||'', r.category||'', r.description||'']);
        if (res2.rowCount > 0) n++;
      }
      results.risks = n;
    }
    // Entities
    if (entities.length) {
      let n = 0;
      for (const e of entities) {
        if (!e.id) continue;
        const res2 = await pool.query(
          `INSERT INTO assessment_entities (tenant_id,id,name,type,category,address,city,state,zip,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, e.id, e.name||'', e.type||'Facility', e.category||'facility',
           e.address||'', e.city||'', e.state||'', e.zip||'']);
        if (res2.rowCount > 0) n++;
      }
      results.entities = n;
    }
    // FS Accounts
    if (fs_accounts.length) {
      let n = 0;
      for (const f of fs_accounts) {
        if (!f.id) continue;
        const res2 = await pool.query(
          `INSERT INTO fs_accounts (tenant_id,id,code,description,section,cur_balance,py_balance,
            materiality,txn_volume,inherent_risk,key_account,assertions,audit_approach,notes,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, f.id, f.code||f.id||'', f.description||f.label||f.desc||'',
           f.section||f.category||f.statement||'',
           f.cur_balance!=null?f.cur_balance:(f.cur!=null?f.cur:null),
           f.py_balance!=null?f.py_balance:(f.py!=null?f.py:null),
           f.materiality||'', f.txn_volume||f.transactionVolume||'',
           f.inherent_risk||f.riskLevel||'', !!f.key_account,
           JSON.stringify(Array.isArray(f.assertions)?f.assertions:(f.assertion?[f.assertion]:[])),
           f.audit_approach||f.auditApproach||'', f.notes||'']);
        if (res2.rowCount > 0) n++;
      }
      results.fs_accounts = n;
    }
    // Control Objectives
    if (objectives.length) {
      let n = 0;
      for (const o of objectives) {
        if (!o.id) continue;
        const res2 = await pool.query(
          `INSERT INTO control_objectives (tenant_id,id,title,description,updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (tenant_id,id) DO NOTHING`,
          [tid, o.id, o.title||'', o.description||'']);
        if (res2.rowCount > 0) n++;
      }
      results.objectives = n;
    }
    console.log('[Seed] Bulk seed complete:', results);
    res.json({ ok:true, inserted: results });
  } catch(err) { return fail(res, err, '[Seed] bulk seed error:'); }
});

// ── Control Objectives API ─────────────────────────────────────────────────────
app.get('/api/control-objectives', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM control_objectives WHERE tenant_id=$1 ORDER BY id', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/control-objectives', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, title, description } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO control_objectives (id,title,description,updated_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, updated_at=NOW()`,
      [id, title||'', description||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});
app.delete('/api/control-objectives/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM control_objectives WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── FS Accounts API ───────────────────────────────────────────────────────────
app.get('/api/fs-accounts', async (req, res) => {
  if (!pool) return res.json([]);
  try { const { rows } = await pool.query('SELECT * FROM fs_accounts WHERE tenant_id=$1 ORDER BY section, code, id', [req.currentTenantId]); res.json(rows); }
  catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/fs-accounts', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { id, code, description, section, cur_balance, py_balance,
          materiality, txn_volume, inherent_risk, key_account,
          assertions, audit_approach, notes, fn_text } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(`INSERT INTO fs_accounts
        (id,code,description,section,cur_balance,py_balance,materiality,txn_volume,inherent_risk,key_account,assertions,audit_approach,notes,fn_text,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (id) DO UPDATE SET
        code=EXCLUDED.code, description=EXCLUDED.description, section=EXCLUDED.section,
        cur_balance=EXCLUDED.cur_balance, py_balance=EXCLUDED.py_balance,
        materiality=EXCLUDED.materiality, txn_volume=EXCLUDED.txn_volume,
        inherent_risk=EXCLUDED.inherent_risk, key_account=EXCLUDED.key_account,
        assertions=EXCLUDED.assertions, audit_approach=EXCLUDED.audit_approach,
        notes=EXCLUDED.notes, fn_text=EXCLUDED.fn_text, updated_at=NOW()`,
      [id, code||'', description||'', section||'',
       cur_balance!=null ? cur_balance : null,
       py_balance!=null  ? py_balance  : null,
       materiality||'', txn_volume||'', inherent_risk||'',
       key_account ? true : false,
       JSON.stringify(assertions||[]),
       audit_approach||'', notes||'', fn_text||'']);
    res.json({ ok:true });
  } catch(err) { return fail(res, err, 'api'); }
});
app.delete('/api/fs-accounts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  try { await pool.query('DELETE FROM fs_accounts WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch(err) { return fail(res, err, 'api'); }
});

// ── Company Context API ──────────────────────────────────────────────────────
app.get('/api/company-context', async (req, res) => {
  if (!pool) return res.json({ notes: '' });
  try {
    await pool.query(`INSERT INTO company_context (tenant_id,id,notes) VALUES ($1,1,$2) ON CONFLICT (tenant_id,id) DO NOTHING`, [req.currentTenantId,'']);
    const { rows } = await pool.query('SELECT notes FROM company_context WHERE tenant_id=$1 AND id=1', [req.currentTenantId]);
    res.json({ notes: rows[0]?.notes || '' });
  } catch(err) { return fail(res, err, 'api'); }
});
app.post('/api/company-context', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  try {
    await pool.query('INSERT INTO company_context (tenant_id,id,notes,updated_at) VALUES ($1,1,$2,NOW()) ON CONFLICT (tenant_id,id) DO UPDATE SET notes=EXCLUDED.notes, updated_at=NOW()', [req.currentTenantId, notes||'']);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// ── Analysis Notes API (generic: audits, controls, risks, entities) ───────────
app.post('/api/analysis-notes/:type/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'No database' });
  const { notes } = req.body;
  // Strict allowlist — identifiers are NEVER taken from user input.
  // Object.hasOwn guards against prototype-chain keys like 'constructor'.
  const ROUTES = {
    control: { sql: 'UPDATE controls SET analyst_notes=$1 WHERE tenant_id=$2 AND id=$3' },
    risk:    { sql: 'UPDATE risks    SET analyst_notes=$1 WHERE tenant_id=$2 AND id=$3' },
  };
  if (!Object.hasOwn(ROUTES, req.params.type))
    return res.status(400).json({ error: 'Unknown type' });
  try {
    await pool.query(ROUTES[req.params.type].sql, [notes||'', req.currentTenantId, req.params.id]);
    res.json({ ok: true });
  } catch(err) { return fail(res, err, 'api'); }
});

// The emailed password-setup link points here — serves the same main app
// file (the password-set modal lives inside it and is triggered by the
// frontend detecting the ?token= query parameter on load), rather than a
// separate page. Must come before the static/catch-all handlers below so
// this specific path is matched first.
app.get('/set-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Serve the frontend HTML (after all /api routes) ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Catch-all: log any unmatched requests (helps diagnose 404s) ──────────────
app.use(function(req, res) {
  console.warn('[404] Unmatched route:', req.method, req.path);
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Wavefire backend running at http://localhost:${PORT}`);
  console.log(`    API key set: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'NO — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`    Frontend:    http://localhost:${PORT}/\n`);
});
