# Railway layout and the Nov 2026 credential rotation

## Why this happened
Railway disclosed a security incident (attack window Oct 20–22, 2026). Attackers pulled encrypted environment variables and decrypted a subset; Railway cannot say which, so every variable in an affected workspace was treated as exposed. Railway also said it rolled all storage-bucket credentials, revoked its access tokens and rolled GitHub App installations, and has not ruled out access to source code. Final report pending. Sources: Railway changelog "October 21 security incident" and "Preliminary report: October security incident" (blog.railway.com).

## Projects
- `just-simplicity` (production): `wavefire_audit` + `Postgres` (+ volume) + bucket `modular-safe`.
- `just-love`: ML service (Python). `ML_SERVICE_URL` in production points at its public domain.
- `charismatic-truth`: no public domain, linked to the same repo; likely unused.

## Rotation actions performed 2026-11-19
- `ANTHROPIC_API_KEY`: replaced. The same new key had briefly been placed in `just-love`, then removed because the ML service does not use Anthropic.
- `VOYAGE_API_KEY`: replaced; old key deleted in the Voyage dashboard.
- Storage: bucket credentials regenerated; `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` updated. (The old secret had stopped matching after Railway's own rotation, which caused signature errors on upload.)
- Database: backup taken first (Postgres Backups tab, 11:14 CST). Password changed with `ALTER USER postgres WITH PASSWORD ...` run in the Postgres Database tab; `POSTGRES_PASSWORD` updated (`PGPASSWORD`, `DATABASE_URL`, `DATABASE_PUBLIC_URL` are references and follow). App `DATABASE_URL` and `POSTGRES_URL` set to `${{Postgres.DATABASE_URL}}`; stray lowercase `database_url` variable deleted. Verified via startup log (`[DB] Connecting to ...`, `DB: all migrations applied`).
- Postgres public TCP proxy removed; app uses the private address `postgres.railway.internal`. To reach the DB from a laptop use `railway connect Postgres` (tunnel), not a public proxy.
- Point-in-time recovery was staged on Postgres (applied on the next deploy).
- `CREDENTIAL_ENCRYPTION_KEY`: generated and set for the first time (it had been unset, which blocked per-tenant AI credentials). Keep a copy in a password manager.
- `ML_SERVICE_TOKEN`: rotated; the value matches on `just-love` and `just-simplicity`.
- GitHub: the Railway GitHub App is installed on a personal account (`damonbwork`) and limited to `damonbwork/wavefire_audit`. Security log showed only D's own login on 2026-11-19 (Brentwood, TN) and routine Copilot token expirations from Sep 22–23. Repo history: no commits after Oct 8; only branches `main` and `claude/auto-updates`.

## Still to do
- Delete or disable the old Anthropic key in the Anthropic console; review usage since Oct 20.
- Check repo Actions (anything after Oct 20), Deploy keys, Webhooks, and Actions secrets.
- Decide whether to delete `charismatic-truth`.
- Optionally configure SMTP; upgrade Node from 18 to 22.

## How to generate a secret on D's PC (Windows PowerShell 5.1)
`$b = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''`
(`RandomNumberGenerator.Fill` is not available on PowerShell 5.1. Run the whole thing as one line.)

## Railway UI notes
- Variable edits are staged until you click Deploy on the project canvas; a reference variable's eye icon shows the applied value, not the staged one.
- Deploy logs for the app: service → Deployments → latest → Deploy Logs.
- Startup log lines to expect: `[DB] Connecting to: ...`, `DB: all migrations applied`; warnings `[SECURITY] CREDENTIAL_ENCRYPTION_KEY...` and `[SMTP] Not fully configured` indicate missing variables.
