// Phase 4A.4 real-browser regression checks: confirmation ordering, desktop and phone, local server and hosted Worker.
//
//   C-01  the page suspects a session replacement (cookie A → B, equal revisions) and sends a confirmation read. The
//         cookie returns to A and a newer natural poll returns unchanged A, which needs no re-render. The delayed
//         confirmation (B) must then be ignored: a newer accepted read supersedes older reads even when it changes
//         nothing on screen.
//   C-02  the same with two overlapping confirmations, released newest first.
//   Guards, which must pass before and after the correction:
//   G-01  replacements that nothing overtakes are still shown: equal revision (B), then lower revision (a new session).
//   G-02  an unchanged poll leaves the page, the typed bet and focus alone; a same-session change is still synchronised.
//   G-03  M-01: a session removed from storage while the newest read is outstanding stays quarantined; explicit
//         recovery still works.
//
// Both adapters are real: server/app.js with server/store.js (local), and server/worker.js on the audit harness's
// node:sqlite D1 stand-in behind a small HTTP bridge (hosted), each from --root. Sessions standing in for another tab are
// created through the public HTTP API; a removal is a test-only write to storage. GET /api/session is scripted with
// Playwright routing: a request can be observed, held before the server, or answered at once and delivered later.
//
// Usage: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node audit/browser-phase4a4.mjs [--root <checkout>] [--adapter local|worker|both] [--out <file>]
// --root runs the server and client of another checkout (used for the red baseline against Phase 4A.3).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workerAdapter } from './lib/harness.mjs';

const here = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const root = path.resolve(arg('root', here)), outFile = arg('out', path.join(here, 'audit/results/browser-phase4a4.json'));
const adapters = { both: ['local', 'worker'], local: ['local'], worker: ['worker'] }[arg('adapter', 'both')];
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const views = [{ name: 'desktop', viewport: { width: 1440, height: 900 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }];
const POLL_MS = 12000, REQUEST_LIMIT_MS = 7000; // public/app.js: background poll interval; AbortSignal.timeout on every request
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });

// One backend per adapter: an origin to load, plus test-only access to stored sessions.
async function startBackend(kind) {
  if (kind === 'local') {
    const { Store } = await import(pathToFileURL(path.join(root, 'server/store.js')).href);
    const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.js')).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-browser-4a4-')), store = await new Store(dir).acquire(), app = createApp(store), origin = await listen(app);
    return { kind, origin, session: id => store.get(id), remove: id => store.transaction(state => { delete state.sessions[id]; }), count: () => Object.keys(store.state.sessions).length,
      close: async () => { await new Promise(r => app.close(r)); store.release(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }
  const { default: worker } = await import(pathToFileURL(path.join(root, 'server/worker.js')).href);
  const d1 = await workerAdapter(), publicDir = path.join(root, 'public');
  const assets = { fetch: async request => {
    const name = new URL(request.url).pathname.slice(1) || 'index.html';
    if (!/^[a-z-]+\.(html|js|css|svg|png)$/.test(name) || !fs.existsSync(path.join(publicDir, name))) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(publicDir, name)), { headers: { 'Content-Type': mime[path.extname(name)] } });
  } };
  const env = { DB: d1.env.DB, ASSETS: assets };
  const bridge = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers(); for (const k of ['cookie', 'content-type', 'origin', 'sec-fetch-site']) if (req.headers[k]) headers.set(k, req.headers[k]);
      const response = await worker.fetch(new Request(origin + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('bridge error: ' + error.message); }
  });
  const origin = await listen(bridge);
  const row = id => d1.sql.prepare('SELECT body FROM cargo_sessions WHERE id = ?').get(id);
  return { kind, origin, session: id => (row(id) ? JSON.parse(row(id).body) : null), remove: id => d1.sql.prepare('DELETE FROM cargo_sessions WHERE id = ?').run(id), count: () => d1.sessionCount(),
    close: async () => { await new Promise(r => bridge.close(r)); await d1.close(); } };
}

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' did not happen within ' + ms + ' ms')), ms))]);
const roundLabel = id => 'ROUND ' + id.slice(0, 8).toUpperCase();
const notice = /synchronized|different demo session/i;

// A second client of the real API with its own cookie (stands in for another tab or device).
function apiClient(origin, cookie = '') {
  const call = async (method, p, body) => {
    const r = await fetch(origin + p, { method, headers: { Cookie: cookie ? 'cargo_session=' + cookie : '', ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body && JSON.stringify(body) });
    const set = /cargo_session=([a-f0-9]{64})/.exec(r.headers.get('set-cookie') || ''); if (set) cookie = set[1];
    const json = await r.json(); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${json.code}`); return json;
  };
  return { id: () => cookie, get: p => call('GET', p), post: (p, body) => call('POST', p, body) };
}
// Session B: another tab starts its own session and bets $3.00 on Hard ($997.00 at revision 1).
async function otherTabSession(be) {
  const c = apiClient(be.origin), s = await c.get('/api/session');
  const next = await c.post('/api/rounds', { actionId: randomUUID(), revision: s.session.revision, difficulty: 'hard', stakeCents: 300, clientSeed: 'phase4a4-other-tab', expectedSeedHash: s.session.nextSeedHash });
  return { id: c.id(), roundId: next.round.id, revision: next.session.revision, balanceCents: next.session.balanceCents };
}

// A scripted hold for one GET /api/session, consumed in request order. With no option the request is only observed.
//   request: true   the request waits before it reaches the server until releaseRequest()
//   response: true  the server answers at once; the browser receives the answer only after releaseResponse()
// The page abandons a request after 7 s, so every hold is released well within that.
function hold({ request = false, response = false } = {}) {
  const arrived = deferred(), answered = deferred(), requestGate = deferred(), responseGate = deferred();
  return { onArrive: () => arrived.resolve(Date.now()), onAnswer: answered.resolve, requestGate: request ? requestGate.promise : null, responseGate: response ? responseGate.promise : null,
    arrived: arrived.promise, answered: answered.promise, releaseRequest: requestGate.resolve, releaseResponse: responseGate.resolve };
}

async function open(be, view, browser) {
  const url = be.origin + '/', context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch, reducedMotion: 'reduce' });
  const page = await context.newPage(), problems = [], log = [], ctl = { gets: [] }, counts = { get: 0, post: 0 };
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource: (the server responded with a status of (404|409)|net::ERR_FAILED)/.test(m.text())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  const label = r => r.method() + ' ' + new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/, ':id');
  page.on('response', r => { if (r.url().includes('/api/')) log.push(label(r.request()) + ' ' + r.status()); });
  page.on('requestfailed', r => { if (r.url().includes('/api/')) log.push(label(r) + ' failed'); });
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') { counts.post++; return route.continue(); }
    counts.get++; const h = ctl.gets.shift();
    if (!h) return route.continue();
    h.onArrive(); if (h.requestGate) await h.requestGate;
    const response = await route.fetch(); h.onAnswer(response.status()); if (h.responseGate) await h.responseGate;
    return route.fulfill({ response });
  });
  const snap = () => page.evaluate(() => {
    const $ = id => document.getElementById(id), text = id => $(id).textContent;
    const controls = [...document.querySelectorAll('#bet-amount,#half-bet,#double-bet,#refill-button,#sail-button,#collect-all,#difficulty button,[data-collect]')];
    return { balance: text('balance'), status: text('save-status'), statusText: text('status-text'), stage: text('stage-badge'), round: text('round-label'),
      sail: { disabled: $('sail-button').disabled, text: text('sail-button') }, cargoButtons: [...document.querySelectorAll('[data-collect]')].map(b => b.textContent),
      enabledControls: controls.filter(e => !e.disabled && !e.hidden).map(e => e.id || 'cargo-' + (e.dataset.collect || e.dataset.mode)),
      mode: document.querySelector('#difficulty [aria-pressed="true"]')?.dataset.mode ?? null, bet: $('bet-amount').value, focus: document.activeElement?.id || '',
      reopen: !!$('reopen-recovery'), reopenVisible: !!$('reopen-recovery')?.getClientRects().length, open: $('modal').open, title: text('modal-title'),
      toast: $('toast').hidden ? '' : text('toast'), renders: window.renders ?? null, balances: window.balanceTexts ?? null, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  const idle = () => page.waitForFunction(() => document.getElementById('status-text').textContent !== 'Action in progress');
  const balance = (text, timeout = 8000) => page.waitForFunction(t => document.getElementById('balance').textContent === t, text, { timeout });
  // From now on: every balance shown, and every re-render (render() rebuilds the cargo cards).
  const watch = () => page.evaluate(() => {
    window.balanceTexts = []; window.renders = 0; const b = document.getElementById('balance');
    new MutationObserver(() => window.balanceTexts.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => window.renders++).observe(document.getElementById('cargo-grid'), { childList: true });
  });
  const visibility = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the page's visibility synchronisation
  const cookie = async () => (await context.cookies()).find(c => c.name === 'cargo_session')?.value;
  const setCookie = id => context.addCookies([{ name: 'cargo_session', value: id, url }]);
  const stage = () => page.waitForFunction(() => /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(document.getElementById('stage-badge').textContent), null, { timeout: 5000 });
  return { url, context, page, problems, log, ctl, counts, snap, idle, balance, watch, visibility, cookie, setCookie, stage };
}

// Session A: a new visitor bets $30.00 on Easy ($970.00, revision 1, active round at the harbour).
async function betSession(t, be) {
  const { page } = t;
  await page.goto(t.url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
  await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
  const id = await t.cookie(); return { id, roundId: be.session(id).currentRoundId };
}
// Reload so the 12-second poll timer restarts at a known time.
async function reloadAt(t, balance) {
  await t.page.reload(); await t.balance(balance); await t.page.waitForSelector('#sail-button:not([disabled])');
  await t.watch(); return { gets: t.counts.get, at: Date.now() };
}
// Wait until the next natural poll is due in `ms`.
const untilPollIn = (t, mark, ms) => t.page.waitForTimeout(Math.max(0, mark.at + POLL_MS - ms - Date.now()));

// Checks shared by C-01 and C-02 after the stale confirmation(s) have been delivered.
async function checkAStays(t, be, a, b, rec, check) {
  const after = rec.afterConfirmation = await t.snap();
  check('A remains displayed: balance $970.00', after.balance === '$970.00', after.balance);
  check('A\'s round, difficulty and stake remain', after.round === roundLabel(a.roundId) && after.mode === 'easy' && after.bet === '30.00', { round: after.round, mode: after.mode, bet: after.bet });
  check('A\'s controls remain: Sail to stop 01, saved status', after.stage === 'READY TO DEPART' && !after.sail.disabled && after.sail.text === 'Sail to stop 01' && /saved/i.test(after.status), { stage: after.stage, sail: after.sail, status: after.status });
  check('no replacement or synchronisation notice', !notice.test(after.toast), after.toast);
  check('B\'s $997.00 was never displayed', !after.balances.includes('$997.00'), after.balances);
  await t.page.click('#sail-button'); await t.stage().catch(() => {}); await t.idle(); await t.page.waitForTimeout(300);
  const sailed = rec.afterSail = await t.snap(), sA = be.session(a.id), sB = be.session(b.id);
  rec.serverAfterSail = { aStep: sA.rounds[a.roundId].step, aRevision: sA.revision, bStep: sB.rounds[b.roundId].step, bRevision: sB.revision, bBalanceCents: sB.balanceCents };
  check('Sail advanced A\'s own round, with no 404', rec.serverAfterSail.aStep === 1 && rec.serverAfterSail.aRevision === 2 && !t.log.some(l => / 404$/.test(l)) && !/not found/i.test(sailed.toast), { server: rec.serverAfterSail, toast: sailed.toast, log: t.log.slice(-4) });
  check('session B is unchanged on the server', rec.serverAfterSail.bStep === 0 && rec.serverAfterSail.bRevision === 1 && rec.serverAfterSail.bBalanceCents === 99700, rec.serverAfterSail);
}

async function checkQuarantined(t, label, check) {
  const s = await t.snap();
  check(label + ': balance "—", no enabled control, "not found" labels', s.balance === '—' && s.enabledControls.length === 0 && s.statusText === 'Session not found' && s.sail.text === 'Session not found', { balance: s.balance, enabled: s.enabledControls, statusText: s.statusText, sail: s.sail.text });
  check(label + ': recovery control present and visible, no notice', s.reopen && s.reopenVisible && /not found/i.test(s.status) && !notice.test(s.toast), { reopen: s.reopen, visible: s.reopenVisible, status: s.status, toast: s.toast });
  return s;
}

// Assertions are recorded one by one, so a run on unfixed code shows exactly which ones fail.
async function scenario(results, be, browser, name, view, fn) {
  const rec = {}, checks = [], check = (assertion, pass, actual) => checks.push(pass ? { assertion, pass: true } : { assertion, pass: false, actual });
  let error, t;
  try { t = await open(be, view, browser); await fn(t, rec, check); } catch (e) { error = e.message.split('\n')[0]; }
  if (t) { check('no console or page errors', t.problems.length === 0, t.problems); rec.log = t.log; await t.context.close().catch(() => {}); }
  const failed = checks.filter(c => !c.pass).map(c => c.assertion), ok = !error && checks.length > 0 && failed.length === 0;
  results.push({ scenario: name, adapter: be.kind, view: view.name, ok, ...(error ? { error } : {}), failed, checks, observations: rec });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name} (${be.kind}, ${view.name})${error ? ' — ' + error : ''}${failed.length ? ' — failed: ' + failed.join('; ') : ''}`);
}

const browser = await chromium.launch(), results = [];
try {
  for (const kind of adapters) {
    const be = await startBackend(kind);
    try {
      for (const view of views) {
        // C-01: A → B → A. The confirmation for B is overtaken by a newer natural poll that returns unchanged A.
        await scenario(results, be, browser, 'C-01 confirmation overtaken by a newer unchanged poll (A → B → A)', view, async (t, rec, check) => {
          const { page } = t, a = await betSession(t, be), b = await otherTabSession(be), sA = be.session(a.id);
          rec.sessions = { a: { revision: sA.revision, balanceCents: sA.balanceCents, round: roundLabel(a.roundId) }, b: { revision: b.revision, balanceCents: b.balanceCents, round: roundLabel(b.roundId) } };
          check('setup: A and B are separate sessions, both at revision 1, with different balances and rounds', a.id !== b.id && sA.revision === 1 && b.revision === 1 && sA.balanceCents === 97000 && b.balanceCents === 99700 && a.roundId !== b.roundId, rec.sessions);
          const mark = await reloadAt(t, '$970.00'), initial = rec.initial = await t.snap();
          check('setup: the browser displays A', initial.balance === '$970.00' && initial.round === roundLabel(a.roundId), { balance: initial.balance, round: initial.round });
          await untilPollIn(t, mark, 3500); // the confirmation must still be pending, within the 7 s request limit, when the poll is answered
          const detect = hold(), confirm = hold({ response: true }), poll = hold(); t.ctl.gets.push(detect, confirm, poll);
          await t.setCookie(b.id); await t.visibility();
          rec.detectStatus = await within(detect.answered, 5000, 'detection read'); const confirmAt = await within(confirm.arrived, 5000, 'confirmation read'); rec.confirmStatus = await within(confirm.answered, 5000, 'confirmation answer');
          const pending = rec.whileConfirming = await t.snap();
          check('the page detected B and sent a confirmation read; the server answered it with B and its delivery is held', rec.detectStatus === 200 && rec.confirmStatus === 200 && t.counts.get - mark.gets === 2, { detect: rec.detectStatus, confirm: rec.confirmStatus, reads: t.counts.get - mark.gets });
          check('while the confirmation is pending, A is still displayed', pending.balance === '$970.00' && pending.round === roundLabel(a.roundId), { balance: pending.balance, round: pending.round });
          await t.setCookie(a.id);
          rec.pollStatus = await within(poll.answered, POLL_MS, 'natural poll'); rec.pollAfterMs = Date.now() - mark.at; await page.waitForTimeout(500);
          const afterPoll = rec.afterPoll = await t.snap();
          check('the newer natural poll returned unchanged A and was accepted with no re-render and no notice', rec.pollStatus === 200 && afterPoll.renders === 0 && afterPoll.balance === '$970.00' && !notice.test(afterPoll.toast), { poll: rec.pollStatus, renders: afterPoll.renders, balance: afterPoll.balance, toast: afterPoll.toast });
          check('validity: exactly three reads (detection, confirmation, poll), confirmation still within the request limit', t.counts.get - mark.gets === 3 && Date.now() - confirmAt < REQUEST_LIMIT_MS - 1000, { reads: t.counts.get - mark.gets, confirmationAgeMs: Date.now() - confirmAt });
          confirm.releaseResponse(); await page.waitForTimeout(800); // the stale confirmation (B) is delivered
          await checkAStays(t, be, a, b, rec, check);
        });

        // C-02: two overlapping confirmations for B, both overtaken by the newer unchanged poll, delivered newest first.
        await scenario(results, be, browser, 'C-02 overlapping confirmations overtaken by a newer unchanged poll', view, async (t, rec, check) => {
          const { page } = t, a = await betSession(t, be), b = await otherTabSession(be);
          const mark = await reloadAt(t, '$970.00'); await untilPollIn(t, mark, 4000);
          const d1 = hold(), c1 = hold({ response: true }), d2 = hold(), c2 = hold({ response: true }), poll = hold(); t.ctl.gets.push(d1, c1, d2, c2, poll);
          await t.setCookie(b.id);
          await t.visibility(); const c1At = await within(c1.arrived, 5000, 'confirmation 1'); rec.c1Status = await within(c1.answered, 5000, 'confirmation 1 answer');
          await t.visibility(); rec.c2Status = await within(c2.answered, 5000, 'confirmation 2 answer');
          check('setup: two detection reads and two confirmations, both answered with B, both held', [await d1.answered, rec.c1Status, await d2.answered, rec.c2Status].every(s => s === 200) && t.counts.get - mark.gets === 4, { reads: t.counts.get - mark.gets });
          await t.setCookie(a.id);
          rec.pollStatus = await within(poll.answered, POLL_MS, 'natural poll'); await page.waitForTimeout(500);
          const afterPoll = rec.afterPoll = await t.snap();
          check('the newer natural poll returned unchanged A with no re-render', rec.pollStatus === 200 && afterPoll.renders === 0 && afterPoll.balance === '$970.00', { renders: afterPoll.renders, balance: afterPoll.balance });
          check('validity: exactly five reads, confirmations still within the request limit', t.counts.get - mark.gets === 5 && Date.now() - c1At < REQUEST_LIMIT_MS - 1000, { reads: t.counts.get - mark.gets, oldestConfirmationAgeMs: Date.now() - c1At });
          c2.releaseResponse(); await page.waitForTimeout(500); c1.releaseResponse(); await page.waitForTimeout(800);
          await checkAStays(t, be, a, b, rec, check);
        });

        // G-01: replacements that nothing overtakes are still shown (equal revision, then lower revision).
        await scenario(results, be, browser, 'G-01 equal- and lower-revision replacements are still shown', view, async (t, rec, check) => {
          const { page } = t, a = await betSession(t, be), b = await otherTabSession(be);
          await t.setCookie(b.id); await t.visibility(); await t.balance('$997.00', 5000); await t.idle();
          const equal = rec.equalRevision = await t.snap();
          check('equal revision: B is shown with its round and the replacement notice', equal.round === roundLabel(b.roundId) && equal.mode === 'hard' && equal.bet === '3.00' && /different demo session/i.test(equal.toast), { round: equal.round, mode: equal.mode, toast: equal.toast });
          await page.click('#sail-button'); await t.stage(); await t.idle();
          check('equal revision: Sail advances B on the server, A untouched', be.session(b.id).rounds[b.roundId].step === 1 && be.session(a.id).rounds[a.roundId].step === 0);
          const fresh = apiClient(be.origin); await fresh.get('/api/session'); // a new session at revision 0
          await t.setCookie(fresh.id()); await page.evaluate(() => document.getElementById('toast').hidden = true); await t.visibility(); await t.balance('$1,000.00', 5000); await t.idle();
          const lower = rec.lowerRevision = await t.snap();
          check('lower revision: the new session is shown with the replacement notice', lower.round === 'PLAY-MONEY PROTOTYPE' && /different demo session/i.test(lower.toast) && /saved/i.test(lower.status), { round: lower.round, toast: lower.toast });
        });

        // G-02: an unchanged poll leaves the page and the typed bet alone; a newer revision of the same session is applied.
        await scenario(results, be, browser, 'G-02 unchanged poll keeps input; same-session change is synchronised', view, async (t, rec, check) => {
          const { page } = t; await betSession(t, be);
          await page.click('#sail-button'); await t.stage(); await t.idle();
          if (await page.isVisible('#collect-all')) { await page.click('#collect-all'); await t.idle(); }
          await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Voyage settled');
          await page.click('#sail-button'); await page.fill('#bet-amount', '45.67'); await t.watch(); // "New voyage", then typing the next bet
          const before = rec.typing = await t.snap(), gets = t.counts.get;
          await page.waitForResponse(r => r.url() === be.origin + '/api/session' && r.request().method() === 'GET', { timeout: POLL_MS + 3000 }); await page.waitForTimeout(600);
          const same = rec.afterSamePoll = await t.snap();
          check('unchanged poll: no re-render, typed bet and focus kept, no notice', t.counts.get - gets === 1 && same.renders === 0 && same.bet === '45.67' && same.focus === 'bet-amount' && same.balance === before.balance && !notice.test(same.toast), { reads: t.counts.get - gets, renders: same.renders, bet: same.bet, focus: same.focus, toast: same.toast });
          const other = apiClient(be.origin, await t.cookie()), current = await other.get('/api/session');
          await other.post('/api/reset', { actionId: randomUUID(), revision: current.session.revision }); // another tab of the same session refills
          await page.waitForResponse(r => r.url() === be.origin + '/api/session' && r.request().method() === 'GET', { timeout: POLL_MS + 3000 });
          await t.balance('$1,000.00', 3000).catch(() => {}); await page.waitForTimeout(300);
          const synced = rec.afterSameSessionChange = await t.snap();
          check('same-session change: new balance shown as a synchronisation, typed bet and focus kept', synced.balance === '$1,000.00' && /synchronized/i.test(synced.toast) && !/different demo session/i.test(synced.toast) && synced.bet === '45.67' && synced.focus === 'bet-amount', { balance: synced.balance, toast: synced.toast, bet: synced.bet, focus: synced.focus });
        });

        // G-03: M-01 still holds. The newest outstanding read was answered before a genuine removal; it arrives after the 404.
        await scenario(results, be, browser, 'G-03 removed session stays quarantined; explicit recovery works', view, async (t, rec, check) => {
          const { page } = t, a = await betSession(t, be);
          const mark = await reloadAt(t, '$970.00'), h1 = hold({ request: true }), h2 = hold({ response: true }); t.ctl.gets.push(h1, h2);
          await t.visibility(); await within(h1.arrived, 5000, 'read 1');
          await t.visibility(); rec.read2Status = await within(h2.answered, 5000, 'read 2');
          const sessions = be.count(); be.remove(a.id); h1.releaseRequest(); rec.read1Status = await within(h1.answered, 5000, 'read 1 answer');
          check('setup: newest read 200 before the removal, older read a genuine 404 after it', rec.read2Status === 200 && rec.read1Status === 404 && be.session(a.id) === null && be.count() === sessions - 1, { read1: rec.read1Status, read2: rec.read2Status });
          await page.waitForSelector('#modal[open] #start-new-session', { timeout: 5000 }); await page.click('#close-modal'); await page.waitForTimeout(300);
          check('validity: only the two scripted reads were sent', t.counts.get - mark.gets === 2 && Date.now() - mark.at < POLL_MS - 500, { reads: t.counts.get - mark.gets });
          rec.closed = await checkQuarantined(t, 'after closing the dialog', check);
          h2.releaseResponse(); await page.waitForTimeout(800);
          const stale = rec.afterStaleSuccess = await checkQuarantined(t, 'after the delayed success', check);
          check('A\'s $970.00 is never shown again after the 404', !stale.balances.slice(stale.balances.indexOf('—')).includes('$970.00'), stale.balances);
          await page.focus('#reopen-recovery', { timeout: 3000 }); await page.keyboard.press('Enter'); await page.waitForSelector('#modal[open] #start-new-session:not([disabled])', { timeout: 3000 });
          const posts = t.counts.post; await page.click('#start-new-session'); await t.balance('$1,000.00'); await page.waitForFunction(() => !document.getElementById('modal').open); await t.idle();
          const recovered = rec.recovered = await t.snap();
          check('explicit recovery: one POST, one new session, loaded and saved', t.counts.post - posts === 1 && be.count() === sessions && recovered.round === 'PLAY-MONEY PROTOTYPE' && /saved/i.test(recovered.status) && !recovered.overflow, { posts: t.counts.post - posts, sessions: be.count(), round: recovered.round });
        });
      }
    } finally { await be.close(); }
  }
} finally { await browser.close(); }
const git = (...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
// The code under test, by content: the results can be generated before the code is committed.
const tested = Object.fromEntries(['public/app.js', 'server/app.js', 'server/store.js', 'server/worker.js', 'server/game.js'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const out = { meta: { script: 'audit/browser-phase4a4.mjs', root, rootHead: git('rev-parse', 'HEAD'), rootUncommitted: git('status', '--porcelain', '--untracked-files=no')?.split('\n').filter(Boolean) ?? null, sha256: tested,
  adapters, node: process.version, chromium: browser.version(), generatedAt: new Date().toISOString(), reducedMotion: true, views: views.map(v => ({ name: v.name, ...v.viewport })) },
  pass: results.length > 0 && results.every(r => r.ok), summary: { scenarios: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => `${r.scenario} (${r.adapter}, ${r.view})`) }, results };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`${out.pass ? 'PASS' : 'FAIL'} phase 4A.4 browser checks: ${out.summary.passed}/${results.length} → ${outFile}`);
process.exitCode = out.pass ? 0 : 1;
