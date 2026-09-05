// Boot-level smoke tests: start the real server with no DB/API key
// configured (the one reliable, zero-external-dependency baseline this
// app supports — see test/helpers/server.mjs), and confirm a handful of
// representative routes behave exactly as server.js's own code says they
// should in that state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.mjs';

let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  if (server) await server.stop();
});

test('GET / serves the frontend HTML', async () => {
  const res = await fetch(server.baseUrl + '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<html/i);
});

test('GET /health returns ok (public route, no auth required)', async () => {
  const res = await fetch(server.baseUrl + '/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.time, 'string');
});

test('GET /api/default-tenant-id is reachable without auth', async () => {
  const res = await fetch(server.baseUrl + '/api/default-tenant-id');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('default_tenant_id' in body);
});

test('GET /api/workpapers without a session is rejected, not silently degraded', async () => {
  // Confirms the auth middleware (server.js:2896) actually gates a real
  // /api/* route, rather than the no-DB degraded-mode path masking a
  // missing auth check.
  const res = await fetch(server.baseUrl + '/api/workpapers');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Not authenticated.');
});

test('GET on an unknown non-API route hits the logged 404 catch-all', async () => {
  // Deliberately NOT under /api/ — an unauthenticated /api/* path is
  // rejected by the auth gate (server.js:2896-2898) before route-matching
  // ever happens, so it 401s regardless of whether the route exists; the
  // 404 catch-all (server.js:8305-8308) is only reachable for paths the
  // auth middleware lets straight through.
  const res = await fetch(server.baseUrl + '/this-page-does-not-exist-xyz');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'Not found');
  assert.equal(body.path, '/this-page-does-not-exist-xyz');
});
