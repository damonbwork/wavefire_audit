// Test harness: spawns the real server.js as a child process with a random
// ephemeral port and NO other env vars set — deliberately exercising the
// no-DB/no-API-key degraded paths, since that's the one reliable,
// zero-external-dependency baseline this app supports (confirmed via the
// pervasive `if (!pool) ...` pattern and per-route ANTHROPIC_API_KEY checks
// in server.js). Real HTTP requests are made against it with global fetch —
// no supertest, no in-process app mounting, since server.js doesn't export
// its Express app and spawning the real process is simpler and closer to
// how the app actually runs in production.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function randomPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

// Real, confirmed fix, per a real, live failure this exact harness hit —
// plain child.kill() is not reliable for terminating a Node child process
// on Windows (it can leave the process, and the port it's bound to, alive
// well past when the test run believes it's done). taskkill's /T flag also
// kills the whole process tree, not just the immediate PID, which matters
// since some startup paths could themselves spawn further children.
function killChildHard(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.pid == null) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve()); // taskkill missing/failed — nothing more we can do
    } else {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }
  });
}

async function waitForReady(baseUrl, child, timeoutMs = 10000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `Server process exited early (code ${child.exitCode}) before becoming ready.\n` +
        `--- stdout ---\n${child._stdout}\n--- stderr ---\n${child._stderr}`
      );
    }
    try {
      const res = await fetch(baseUrl + '/health');
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(
    `Server did not become ready within ${timeoutMs}ms. Last error: ${lastErr?.message}\n` +
    `--- stdout ---\n${child._stdout}\n--- stderr ---\n${child._stderr}`
  );
}

// Starts the real server as a child process. Returns { baseUrl, stop() }.
export async function startServer() {
  const port = randomPort();
  const nodeExe = process.execPath; // the same Node binary running this test
  // Clears every env var server.js checks for a DB connection string or an
  // Anthropic key, regardless of what the host environment (or a loaded
  // .env) might otherwise set — this suite is specifically about the
  // no-external-services baseline, not whatever happens to be configured
  // on the machine running it.
  const clearedEnv = { ...process.env };
  for (const key of [
    'DATABASE_URL', 'database_url', 'POSTGRES_URL', 'DATABASE_PRIVATE_URL', 'DATABASE_PUBLIC_URL',
    'ANTHROPIC_API_KEY',
  ]) delete clearedEnv[key];

  const child = spawn(nodeExe, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...clearedEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child._stdout = '';
  child._stderr = '';
  child.stdout.on('data', d => { child._stdout += d.toString(); });
  child.stderr.on('data', d => { child._stderr += d.toString(); });

  const baseUrl = `http://localhost:${port}`;
  try {
    await waitForReady(baseUrl, child);
  } catch (err) {
    // Real, confirmed fix — if readiness never happens, the child was
    // still spawned and must be killed here. Previously this rethrew
    // without killing anything, since the caller never received a handle
    // to clean up — the child was orphaned for good, still bound to its
    // port, for every failed startServer() call.
    await killChildHard(child);
    throw err;
  }

  return {
    baseUrl,
    stop: () => killChildHard(child),
  };
}
