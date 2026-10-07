// Test harness that drives the two REAL adapters with an identical client API:
//   local  – server/app.js over HTTP with server/store.js in a temporary directory
//   worker – server/worker.js fetch() with an in-memory node:sqlite D1 stand-in
// Fault injection and the D1 row limit are emulated in the DATABASE STAND-IN or
// via test-only fixture writes to stored session state; production files are
// never modified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../server/store.js';
import { createApp } from '../../server/app.js';
import worker from '../../server/worker.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migration = () => fs.readFileSync(path.join(root, 'drizzle', fs.readdirSync(path.join(root, 'drizzle')).find(f => f.endsWith('.sql'))), 'utf8');
const tick = () => new Promise(r => setImmediate(r));

function cookieJar() {
  let cookie = '';
  return { header: () => cookie, take(h) { if (h) cookie = h.split(';')[0]; }, set(c) { cookie = c; }, id: () => /cargo_session=([a-f0-9]{64})/.exec(cookie)?.[1] };
}

export async function localAdapter() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-audit-')), store = new Store(directory), app = createApp(store);
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.address().port;
  const client = (jar = cookieJar()) => ({
    jar, kind: 'local', url,
    async get(p, headers = {}) { const r = await fetch(url + p, { headers: { Cookie: jar.header(), ...headers } }); jar.take(r.headers.get('set-cookie')); return { status: r.status, body: await r.json().catch(() => null) }; },
    async post(p, input, headers = {}, rawBody) {
      const r = await fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header(), Origin: url, ...headers }, body: rawBody ?? JSON.stringify(input) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    raw: () => store.get(jar.id()),
    async mutate(fn) { fn(store.state.sessions[jar.id()]); },
    fork() { return client(cookieJar()); }
  });
  return { kind: 'local', store, directory, url, app, client, sessionCount: () => Object.keys(store.state.sessions).length,
    async close() { await new Promise(r => app.close(r)); fs.rmSync(directory, { recursive: true, force: true }); } };
}

export async function workerAdapter({ maxBodyBytes = null } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(':memory:'); sql.exec(migration());
  const faults = { beforeUpdate: 0, afterUpdate: 0, beforeRead: 0, beforeInsert: 0, maxBodyBytes };
  const DB = { prepare(query) { return { bind(...values) { return {
    async first() { await tick(); if (faults.beforeRead > 0) { faults.beforeRead--; throw new Error('injected read failure'); } return sql.prepare(query).get(...values) || null; },
    async run() {
      await tick();
      if (query.startsWith('INSERT') && faults.beforeInsert > 0) { faults.beforeInsert--; throw new Error('injected failure before insert'); }
      if (query.startsWith('UPDATE') && faults.beforeUpdate > 0) { faults.beforeUpdate--; throw new Error('injected failure before update'); }
      // Emulates Cloudflare D1's documented 2,000,000-byte string/BLOB/row limit.
      if (faults.maxBodyBytes && values.some(v => typeof v === 'string' && Buffer.byteLength(v) > faults.maxBodyBytes)) throw new Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG');
      const result = sql.prepare(query).run(...values);
      if (query.startsWith('UPDATE') && faults.afterUpdate > 0) { faults.afterUpdate--; throw new Error('injected failure after update'); }
      return { meta: { changes: Number(result.changes) } };
    } }; } }; } };
  const env = { DB, ASSETS: { fetch: () => new Response('asset') } };
  const origin = 'https://cargo.test';
  // `impl` lets a test drive the same database with a different Worker build (a later deployment).
  const state = { impl: worker };
  const client = (jar = cookieJar()) => ({
    jar, kind: 'worker', url: origin,
    async get(p, headers = {}) { const r = await state.impl.fetch(new Request(origin + p, { headers: { Cookie: jar.header(), ...headers } }), env); jar.take(r.headers.get('set-cookie')); return { status: r.status, body: await r.json().catch(() => null) }; },
    async post(p, input, headers = {}, rawBody) {
      const r = await state.impl.fetch(new Request(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar.header(), Origin: origin, ...headers }, body: rawBody ?? JSON.stringify(input) }), env);
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    raw() { const row = sql.prepare('SELECT body FROM cargo_sessions WHERE id = ?').get(jar.id()); return row ? JSON.parse(row.body) : null; },
    rawBytes() { const row = sql.prepare('SELECT length(CAST(body AS BLOB)) AS n FROM cargo_sessions WHERE id = ?').get(jar.id()); return row ? Number(row.n) : 0; },
    async mutate(fn) { const s = this.raw(); fn(s); sql.prepare('UPDATE cargo_sessions SET body = ? WHERE id = ?').run(JSON.stringify(s), jar.id()); },
    fork() { return client(cookieJar()); }
  });
  return { kind: 'worker', sql, faults, env, client, useWorker(impl) { state.impl = impl; }, sessionCount: () => Number(sql.prepare('SELECT count(*) AS n FROM cargo_sessions').get().n), async close() { sql.close(); } };
}

export const ADAPTERS = { local: localAdapter, worker: workerAdapter };

// Helpers shared by system checks and regression tests.
let actionCounter = 0;
export const aid = (prefix = 'act') => `${prefix}-${String(++actionCounter).padStart(8, '0')}`;
export async function startSession(c) { const r = await c.get('/api/session'); if (r.status !== 200) throw new Error('session failed ' + r.status); return r.body; }
export async function bet(c, { difficulty = 'easy', stakeCents = 3000, clientSeed = 'audit', actionId = aid('bet') } = {}) {
  const s = (await c.get('/api/session')).body;
  return c.post('/api/rounds', { difficulty, stakeCents, clientSeed, expectedSeedHash: s.session.nextSeedHash, revision: s.session.revision, actionId });
}
export async function act(c, route, extra = {}) {
  const s = (await c.get('/api/session')).body;
  return c.post(route, { revision: s.session.revision, actionId: aid('a'), ...extra });
}
export function ledgerInvariant(session) {
  const sum = session.ledger.reduce((a, e) => a + e.amountCents, 0);
  const ids = new Set(session.ledger.map(e => e.id));
  const refills = session.ledger.filter(e => e.kind === 'refill').length;
  return { ok: 100000 + sum === session.balanceCents && ids.size === session.ledger.length && session.balanceCents >= 0, start: 100000, sum, balance: session.balanceCents, entries: session.ledger.length, refills };
}
