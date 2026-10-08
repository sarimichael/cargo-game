// Phase 4A.3 real-browser regression checks: browser state consistency (M-01, M-02), desktop and phone.
//
//   M-01  once the server has confirmed that the loaded session is missing, no session read sent before that answer,
//         including the most recently sent one, may bring the vanished session back (balance, round, status or
//         controls), whether it later succeeds or fails. The recovery control stays usable, and recovery the player
//         starts afterwards (Try again, Start a new demo session) still works.
//   M-02  an accepted session read shows a different session even when its revision equals the one on screen, while
//         an unchanged session read leaves the page and the player's input alone.
//
// The real local server (server/app.js and server/store.js of --root) runs in this process on a temporary data
// directory, so a session can be genuinely removed from its storage by a test-only store transaction; the browser then
// receives the server's own 404 SESSION_NOT_FOUND. Sessions standing in for another tab are created through the
// public HTTP API. GET and POST /api/session are scripted with Playwright routing: a request can be held before it
// reaches the server, or answered by the server at once and delivered to the browser later.
//
// Usage: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node audit/browser-phase4a3.mjs [--root <checkout>] [--out <file>]
// --root runs the server and client of another checkout (used for the red baseline against Phase 4A.2).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const root = path.resolve(arg('root', here)), outFile = arg('out', path.join(here, 'audit/results/browser-phase4a3.json'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const { Store } = await import(pathToFileURL(path.join(root, 'server/store.js')).href);
const { createApp } = await import(pathToFileURL(path.join(root, 'server/app.js')).href);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-browser-4a3-')), store = await new Store(dataDir).acquire(), app = createApp(store);
await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${app.address().port}`, url = origin + '/', browser = await chromium.launch(), results = [];
const views = [{ name: 'desktop', viewport: { width: 1440, height: 900 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }];
const POLL_MS = 12000; // public/app.js background poll interval

const sessionCount = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).sessions).length;
// Test-only removal of a session from the server's storage (memory and state.json), as an operator clean-up or a
// storage fault would do. Every later request with its cookie receives the server's genuine 404 SESSION_NOT_FOUND.
const removeSession = id => store.transaction(state => { delete state.sessions[id]; });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' did not happen within ' + ms + ' ms')), ms))]);
const roundLabel = id => 'ROUND ' + id.slice(0, 8).toUpperCase();

// A second client of the real API with its own cookie (stands in for another tab or device).
function apiClient(cookie = '') {
  const call = async (method, p, body) => {
    const r = await fetch(origin + p, { method, headers: { Cookie: cookie ? 'cargo_session=' + cookie : '', ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body && JSON.stringify(body) });
    const set = /cargo_session=([a-f0-9]{64})/.exec(r.headers.get('set-cookie') || ''); if (set) cookie = set[1];
    const json = await r.json(); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${json.code}`); return json;
  };
  return { id: () => cookie, get: p => call('GET', p), post: (p, body) => call('POST', p, body) };
}
// Another tab of the same browser starts its own session and bets $3.00 on Hard: $997.00 at revision 1.
async function otherTabSession() {
  const c = apiClient(), s = await c.get('/api/session');
  const next = await c.post('/api/rounds', { actionId: randomUUID(), revision: s.session.revision, difficulty: 'hard', stakeCents: 300, clientSeed: 'phase4a3-other-tab', expectedSeedHash: s.session.nextSeedHash });
  return { id: c.id(), roundId: next.round.id, revision: next.session.revision, balanceCents: next.session.balanceCents };
}

// A scripted hold for one /api/session request, consumed in request order.
//   request: true   the request waits before it reaches the server until releaseRequest()
//   response: true  the server answers at once; the browser receives the answer only after releaseResponse()
//   fail: true      the browser then receives a network failure instead of the server's answer
// The page abandons a request after 7 s, so every hold is released well within that.
function hold({ request = false, response = false, fail = false } = {}) {
  const arrived = deferred(), answered = deferred(), requestGate = deferred(), responseGate = deferred();
  return { fail, onArrive: arrived.resolve, onAnswer: answered.resolve, requestGate: request ? requestGate.promise : null, responseGate: response ? responseGate.promise : null,
    arrived: arrived.promise, answered: answered.promise, releaseRequest: requestGate.resolve, releaseResponse: responseGate.resolve };
}

async function open(view) {
  const context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch, reducedMotion: 'reduce' });
  const page = await context.newPage(), problems = [], log = [], ctl = { gets: [], posts: [] }, counts = { get: 0, post: 0 };
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource: (the server responded with a status of (404|409)|net::ERR_FAILED)/.test(m.text())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  const label = r => r.method() + ' ' + new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/, ':id');
  page.on('response', r => { if (r.url().includes('/api/')) log.push(label(r.request()) + ' ' + r.status()); });
  page.on('requestfailed', r => { if (r.url().includes('/api/')) log.push(label(r) + ' failed'); });
  await page.route('**/api/session', async route => {
    const get = route.request().method() === 'GET'; counts[get ? 'get' : 'post']++;
    const h = (get ? ctl.gets : ctl.posts).shift();
    if (!h) return route.continue();
    h.onArrive(); if (h.requestGate) await h.requestGate;
    const response = await route.fetch(); h.onAnswer(response.status()); if (h.responseGate) await h.responseGate;
    return h.fail ? route.abort('failed') : route.fulfill({ response });
  });
  const snap = () => page.evaluate(() => {
    const $ = id => document.getElementById(id), text = id => $(id).textContent;
    const controls = [...document.querySelectorAll('#bet-amount,#half-bet,#double-bet,#refill-button,#sail-button,#collect-all,#difficulty button,[data-collect]')];
    return { balance: text('balance'), secured: text('secured'), onboard: text('onboard'), status: text('save-status'), statusText: text('status-text'), stage: text('stage-badge'), round: text('round-label'),
      sail: { disabled: $('sail-button').disabled, text: text('sail-button') }, cargoButtons: [...document.querySelectorAll('[data-collect]')].map(b => b.textContent),
      enabledControls: controls.filter(e => !e.disabled && !e.hidden).map(e => e.id || 'cargo-' + (e.dataset.collect || e.dataset.mode)),
      mode: document.querySelector('#difficulty [aria-pressed="true"]')?.dataset.mode ?? null, bet: $('bet-amount').value, focus: document.activeElement?.id || '',
      reopen: !!$('reopen-recovery'), reopenVisible: !!$('reopen-recovery')?.getClientRects().length, open: $('modal').open, title: text('modal-title'),
      toast: $('toast').hidden ? '' : text('toast'), overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  const idle = () => page.waitForFunction(() => document.getElementById('status-text').textContent !== 'Action in progress');
  const balance = (text, timeout = 8000) => page.waitForFunction(t => document.getElementById('balance').textContent === t, text, { timeout });
  // Every balance shown from now on, in order.
  const watchBalance = () => page.evaluate(() => { window.balanceTexts = []; const b = document.getElementById('balance'); new MutationObserver(() => window.balanceTexts.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true }); });
  const visibility = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the page's visibility synchronization
  const cookie = async () => (await context.cookies()).find(c => c.name === 'cargo_session')?.value;
  const setCookie = id => context.addCookies([{ name: 'cargo_session', value: id, url }]);
  return { context, page, problems, log, ctl, counts, snap, idle, balance, watchBalance, visibility, cookie, setCookie };
}

// Session A: a new visitor bets $30.00 on Easy ($970.00, revision 1, active round at the harbour).
async function betSession(t) {
  const { page } = t;
  await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
  await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
  const id = await t.cookie(); return { id, roundId: store.get(id).currentRoundId, round: (await t.snap()).round };
}
// Reload so the 12-second poll timer restarts; scripted reads then complete well before the first poll.
async function reloadForHolds(t) {
  await t.page.reload(); await t.balance('$970.00'); await t.page.waitForSelector('#sail-button:not([disabled])');
  await t.watchBalance(); return { gets: t.counts.get, at: Date.now() };
}
// The scripted reads must be the only reads in the window, or the holds would be applied to a different request.
function checkNoPoll(t, mark, expected, check) {
  const extra = t.counts.get - mark.gets, ms = Date.now() - mark.at;
  check('validity: only the scripted reads were sent (no natural poll in the window)', extra === expected && ms < POLL_MS - 500, { reads: extra, expected, ms });
}
// Balances shown after the first "—" and before the given recovered balance.
const between = (texts, until) => { const from = texts.indexOf('—'); if (from < 0) return null; const rest = texts.slice(from); const end = rest.indexOf(until); return end < 0 ? rest : rest.slice(0, end); };

function checkQuarantined(s, label, check, { dialog }) {
  check(label + ': balance, secured and on-board values show "—"', s.balance === '—' && s.secured === '—' && s.onboard === '—', { balance: s.balance, secured: s.secured, onboard: s.onboard });
  check(label + ': no play-money control is enabled', s.enabledControls.length === 0, s.enabledControls);
  check(label + ': status, stage and action labels say the session was not found', s.statusText === 'Session not found' && s.stage === 'SESSION NOT FOUND' && s.sail.text === 'Session not found' && s.cargoButtons.every(x => x === 'Unavailable'),
    { statusText: s.statusText, stage: s.stage, sail: s.sail.text, cargo: s.cargoButtons });
  if (dialog === 'open') check(label + ': recovery dialog is open', s.open && s.title === 'Saved session not found', { open: s.open, title: s.title });
  if (dialog === 'closed') check(label + ': dialog stays closed and the recovery control is present and visible', !s.open && s.reopen && s.reopenVisible && /not found/i.test(s.status), { open: s.open, reopen: s.reopen, visible: s.reopenVisible, status: s.status });
  check(label + ': no synchronisation or replacement notice', !/synchronized|different demo session/i.test(s.toast), s.toast);
}
// Recovery from the status-line control (keyboard), then one explicit start, then a usable new session.
async function explicitRecovery(t, rec, check) {
  const { page } = t, posts = t.counts.post;
  await page.focus('#reopen-recovery', { timeout: 3000 }); await page.keyboard.press('Enter');
  await page.waitForSelector('#modal[open] #start-new-session:not([disabled])', { timeout: 3000 });
  const reopened = rec.reopened = await t.snap();
  check('recovery: the status-line control reopens the dialog from the keyboard', reopened.open && reopened.title === 'Saved session not found', { open: reopened.open, title: reopened.title });
  const sessions = sessionCount();
  await page.click('#start-new-session'); await t.balance('$1,000.00'); await page.waitForFunction(() => !document.getElementById('modal').open); await t.idle();
  const recovered = rec.recovered = { ...(await t.snap()), posts: t.counts.post - posts, sessionsAdded: sessionCount() - sessions };
  check('recovery: one explicit start sends one POST and creates one session', recovered.posts === 1 && recovered.sessionsAdded === 1, { posts: recovered.posts, sessionsAdded: recovered.sessionsAdded });
  check('recovery: the new session is loaded and saved', /saved/i.test(recovered.status) && recovered.round === 'PLAY-MONEY PROTOTYPE' && !recovered.open, { status: recovered.status, round: recovered.round });
  await page.fill('#bet-amount', '30.00'); await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
  const usable = rec.usable = await t.snap();
  check('recovery: the new session accepts a bet', /^ROUND /.test(usable.round) && /saved/i.test(usable.status) && !usable.overflow, { round: usable.round, status: usable.status, overflow: usable.overflow });
}

// Assertions are recorded one by one, so a run on unfixed code shows exactly which ones fail. A step that times out
// (because the unfixed page is in an unexpected state) ends the scenario and is reported with the checks made so far.
async function scenario(name, view, fn) {
  const rec = {}, checks = [], check = (assertion, pass, actual) => checks.push(pass ? { assertion, pass: true } : { assertion, pass: false, actual });
  let error;
  try { await fn(rec, check); } catch (e) { error = e.message.split('\n')[0]; }
  const t = rec.t; delete rec.t;
  if (t) { check('no console or page errors', t.problems.length === 0, t.problems); rec.log = t.log; await t.context.close().catch(() => {}); }
  const failed = checks.filter(c => !c.pass).map(c => c.assertion), ok = !error && checks.length > 0 && failed.length === 0;
  results.push({ scenario: name, view: view.name, ok, ...(error ? { error } : {}), failed, checks, observations: rec });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name} (${view.name})${error ? ' — ' + error : ''}${failed.length ? ' — failed: ' + failed.join('; ') : ''}`);
}

try {
  for (const view of views) {
    // M-01 (the reported defect): the newest outstanding read was answered before the session was removed and is
    // delivered after the server's 404 for an older read has quarantined the page.
    await scenario('M-01 newest outstanding read cannot restore a deleted session', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t); rec.sessionA = { round: a.round };
      const mark = await reloadForHolds(t), h1 = hold({ request: true }), h2 = hold({ response: true }); t.ctl.gets.push(h1, h2);
      await t.visibility(); await within(h1.arrived, 5000, 'read 1');                       // read 1 waits before the server
      await t.visibility(); rec.read2Status = await within(h2.answered, 5000, 'read 2');      // read 2 (newest): answered with session A
      const before = sessionCount(); removeSession(a.id); rec.sessionsAfterRemoval = sessionCount();
      check('setup: session A was removed from server storage', store.get(a.id) === null && rec.sessionsAfterRemoval === before - 1);
      h1.releaseRequest(); rec.read1Status = await within(h1.answered, 5000, 'read 1 answer');
      check('setup: the newest read was answered 200 before the removal', rec.read2Status === 200, rec.read2Status);
      check('setup: the older read received a genuine 404 after the removal', rec.read1Status === 404, rec.read1Status);
      await page.waitForSelector('#modal[open] #start-new-session', { timeout: 5000 }); await page.waitForTimeout(300);
      checkQuarantined(rec.quarantined = await t.snap(), 'after the 404', check, { dialog: 'open' });
      await page.click('#close-modal'); await page.waitForTimeout(300);
      const closed = rec.closed = await t.snap(); checkQuarantined(closed, 'after closing the dialog', check, { dialog: 'closed' });
      checkNoPoll(t, mark, 2, check);
      h2.releaseResponse(); await page.waitForTimeout(800);                                    // the stale success arrives
      const stale = rec.afterStaleSuccess = await t.snap();
      await page.screenshot({ path: path.join(os.tmpdir(), `cargo-4a3-m01-${view.name}.png`), fullPage: true });
      checkQuarantined(stale, 'after the delayed success', check, { dialog: 'closed' });
      check('after the delayed success: round label unchanged', stale.round === closed.round, { before: closed.round, after: stale.round });
      const shown = rec.balancesAfterQuarantine = between(await page.evaluate(() => window.balanceTexts), '$1,000.00');
      check('session A\'s $970.00 is never shown again after the 404', shown && !shown.includes('$970.00'), shown);
      check('no session was created automatically', sessionCount() === rec.sessionsAfterRemoval, sessionCount());
      await explicitRecovery(t, rec, check);
      check('session A stays removed on the server', store.get(a.id) === null);
    });

    // M-01 with concurrent recovery: the player chooses Try again (another tab has meanwhile started session B), and
    // the stale success for session A arrives while that legitimate recovery read is outstanding.
    await scenario('M-01 stale read released during an explicit recovery read', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t), b = await otherTabSession(); rec.sessionB = { round: roundLabel(b.roundId), revision: b.revision };
      const mark = await reloadForHolds(t), h1 = hold({ request: true }), h2 = hold({ response: true }); t.ctl.gets.push(h1, h2);
      await t.visibility(); await within(h1.arrived, 5000, 'read 1');
      await t.visibility(); rec.read2Status = await within(h2.answered, 5000, 'read 2');
      removeSession(a.id); h1.releaseRequest(); rec.read1Status = await within(h1.answered, 5000, 'read 1 answer');
      check('setup: newest read 200 before the removal, older read 404 after it', rec.read2Status === 200 && rec.read1Status === 404, { read1: rec.read1Status, read2: rec.read2Status });
      await page.waitForSelector('#modal[open] #retry-session:not([disabled])', { timeout: 5000 });
      checkNoPoll(t, mark, 2, check);
      await t.setCookie(b.id);
      const h3 = hold({ response: true }); t.ctl.gets.push(h3);
      await page.click('#retry-session'); rec.recoveryReadStatus = await within(h3.answered, 5000, 'recovery read');
      check('setup: the recovery read was answered 200 with session B', rec.recoveryReadStatus === 200, rec.recoveryReadStatus);
      h2.releaseResponse(); await page.waitForTimeout(800);                                    // stale success for A
      const during = rec.duringRecovery = await t.snap();
      checkQuarantined(during, 'while the recovery read is outstanding', check, { dialog: 'open' });
      h3.releaseResponse(); await t.balance('$997.00', 5000); await page.waitForFunction(() => !document.getElementById('modal').open); await t.idle();
      const loaded = rec.recovered = await t.snap();
      check('recovery read: session B is shown with its round and difficulty', loaded.balance === '$997.00' && loaded.round === roundLabel(b.roundId) && loaded.mode === 'hard' && loaded.bet === '3.00', { balance: loaded.balance, round: loaded.round, mode: loaded.mode, bet: loaded.bet });
      check('recovery read: session B is saved and playable', /saved/i.test(loaded.status) && !loaded.sail.disabled && loaded.sail.text === 'Sail to stop 01', { status: loaded.status, sail: loaded.sail });
      const shown = rec.balancesAfterQuarantine = between(await page.evaluate(() => window.balanceTexts), '$997.00');
      check('session A\'s $970.00 is never shown again after the 404', shown && !shown.includes('$970.00'), shown);
      await page.click('#sail-button'); await page.waitForFunction(() => /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(document.getElementById('stage-badge').textContent), null, { timeout: 5000 }); await t.idle();
      const serverB = store.get(b.id); rec.serverAfterSail = { bStep: serverB.rounds[b.roundId].step, bRevision: serverB.revision, aPresent: store.get(a.id) !== null };
      check('Sail acts on session B on the server', rec.serverAfterSail.bStep === 1 && rec.serverAfterSail.bRevision === 2, rec.serverAfterSail);
      check('session A stays removed on the server', !rec.serverAfterSail.aPresent);
    });

    // M-01 guard: late failures (a 404 answered after the removal, and a network failure) change nothing and do not
    // reopen a dialog the player closed.
    await scenario('M-01 delayed failures after quarantine change nothing', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t);
      const mark = await reloadForHolds(t), h1 = hold({ request: true }), h2 = hold({ request: true }), h3 = hold({ response: true, fail: true }); t.ctl.gets.push(h1, h2, h3);
      await t.visibility(); await within(h1.arrived, 5000, 'read 1');
      await t.visibility(); await within(h2.arrived, 5000, 'read 2');
      await t.visibility(); rec.read3Status = await within(h3.answered, 5000, 'read 3');
      removeSession(a.id); const sessions = sessionCount();
      h1.releaseRequest(); rec.read1Status = await within(h1.answered, 5000, 'read 1 answer');
      await page.waitForSelector('#modal[open] #start-new-session', { timeout: 5000 }); await page.click('#close-modal'); await page.waitForTimeout(300);
      checkQuarantined(rec.closed = await t.snap(), 'after closing the dialog', check, { dialog: 'closed' });
      checkNoPoll(t, mark, 3, check);
      h2.releaseRequest(); rec.read2Status = await within(h2.answered, 5000, 'read 2 answer'); await page.waitForTimeout(600);
      checkQuarantined(rec.afterLate404 = await t.snap(), 'after a delayed 404', check, { dialog: 'closed' });
      h3.releaseResponse(); await page.waitForTimeout(600);
      const failed = rec.afterLateFailure = await t.snap(); checkQuarantined(failed, 'after a delayed network failure', check, { dialog: 'closed' });
      check('after a delayed network failure: no error notice', !/could not|connect/i.test(failed.toast), failed.toast);
      check('setup: answers were 404, 404 and 200 (then a network failure)', rec.read1Status === 404 && rec.read2Status === 404 && rec.read3Status === 200, { read1: rec.read1Status, read2: rec.read2Status, read3: rec.read3Status });
      check('no session was created automatically', sessionCount() === sessions, sessionCount());
      await explicitRecovery(t, rec, check);
    });

    // M-01 guard, polling: the newest outstanding read is the natural 12-second poll.
    await scenario('M-01 delayed poll response after quarantine', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t);
      const mark = await reloadForHolds(t), h1 = hold({ request: true }), h2 = hold({ response: true }); t.ctl.gets.push(h1, h2);
      // Send read 1 shortly before the poll is due: the page abandons any request after 7 s (AbortSignal.timeout).
      await page.waitForTimeout(Math.max(0, mark.at + POLL_MS - 2500 - Date.now()));
      await t.visibility(); await within(h1.arrived, 5000, 'read 1');
      rec.pollStatus = await within(h2.answered, 5000, 'natural poll'); rec.pollAfterMs = Date.now() - mark.at;
      removeSession(a.id); h1.releaseRequest(); rec.read1Status = await within(h1.answered, 5000, 'read 1 answer');
      check('setup: the poll was answered 200 before the removal, the older read 404 after it', rec.pollStatus === 200 && rec.read1Status === 404, { poll: rec.pollStatus, read1: rec.read1Status });
      check('validity: exactly two reads (the visibility read and one poll)', t.counts.get - mark.gets === 2, t.counts.get - mark.gets);
      await page.waitForSelector('#modal[open] #start-new-session', { timeout: 5000 }); await page.click('#close-modal'); await page.waitForTimeout(300);
      checkQuarantined(rec.closed = await t.snap(), 'after closing the dialog', check, { dialog: 'closed' });
      h2.releaseResponse(); await page.waitForTimeout(800);
      checkQuarantined(rec.afterStalePoll = await t.snap(), 'after the delayed poll response', check, { dialog: 'closed' });
      const shown = between(await page.evaluate(() => window.balanceTexts), '$1,000.00');
      check('session A\'s $970.00 is never shown again after the 404', shown && !shown.includes('$970.00'), shown);
      await explicitRecovery(t, rec, check);
    });

    // M-01 guard, async action completion: the session is genuinely removed while a read is outstanding, and the
    // player's next action receives the 404 (4A.2 tested this only by pointing the cookie at a nonexistent session).
    await scenario('M-01 genuine removal reported by an action', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t);
      const mark = await reloadForHolds(t), h1 = hold({ response: true }); t.ctl.gets.push(h1);
      await t.visibility(); rec.readStatus = await within(h1.answered, 5000, 'read');
      removeSession(a.id); const sessions = sessionCount();
      await page.click('#sail-button'); await page.waitForSelector('#modal[open] #start-new-session', { timeout: 5000 }); await t.idle(); await page.waitForTimeout(300);
      checkQuarantined(rec.afterAction = await t.snap(), 'after the action\'s 404', check, { dialog: 'open' });
      check('setup: the advance received a genuine 404', t.log.includes('POST /api/rounds/:id/advance 404'), t.log);
      await page.click('#close-modal'); await page.waitForTimeout(300);
      checkNoPoll(t, mark, 1, check);
      h1.releaseResponse(); await page.waitForTimeout(800);
      checkQuarantined(rec.afterStaleRead = await t.snap(), 'after the delayed read', check, { dialog: 'closed' });
      check('setup: the read was answered 200 before the removal', rec.readStatus === 200, rec.readStatus);
      check('no session was created automatically', sessionCount() === sessions, sessionCount());
      await explicitRecovery(t, rec, check);
    });

    // M-02 (the reported defect): two sessions with equal revisions; the browser's cookie changes from A to B and
    // only the natural poll runs.
    await scenario('M-02 equal-revision session replacement through the natural poll', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t, a = await betSession(t), b = await otherTabSession();
      const serverA = store.get(a.id); rec.sessions = { a: { balanceCents: serverA.balanceCents, revision: serverA.revision, round: a.round }, b: { balanceCents: b.balanceCents, revision: b.revision, round: roundLabel(b.roundId) } };
      check('setup: A ($970.00) and B ($997.00) have the same revision', serverA.revision === 1 && b.revision === 1 && serverA.balanceCents === 97000 && b.balanceCents === 99700, rec.sessions);
      await page.evaluate(() => { window.visibilityEvents = 0; document.addEventListener('visibilitychange', () => window.visibilityEvents++, true); });
      rec.beforeSwitch = await t.snap();
      await t.setCookie(b.id); const gets = t.counts.get, at = Date.now();
      await page.waitForResponse(r => r.url() === origin + '/api/session' && r.request().method() === 'GET', { timeout: POLL_MS + 3000 });
      rec.firstPollAfterMs = Date.now() - at;
      await t.balance('$997.00', 3000).catch(() => {}); await page.waitForTimeout(400);
      const after = rec.afterPoll = { ...(await t.snap()), reads: t.counts.get - gets, visibilityEvents: await page.evaluate(() => window.visibilityEvents) };
      check('setup: no visibility synchronisation was triggered', after.visibilityEvents === 0, after.visibilityEvents);
      check('after the poll: B\'s balance is shown', after.balance === '$997.00', after.balance);
      check('after the poll: B\'s round, difficulty and stake are shown', after.round === roundLabel(b.roundId) && after.mode === 'hard' && after.bet === '3.00', { round: after.round, mode: after.mode, bet: after.bet });
      check('after the poll: controls match B\'s round at the harbour', after.stage === 'READY TO DEPART' && !after.sail.disabled && after.sail.text === 'Sail to stop 01' && /saved/i.test(after.status), { stage: after.stage, sail: after.sail, status: after.status });
      check('after the poll: the player is told the session changed', /different demo session/i.test(after.toast), after.toast);
      await page.click('#sail-button'); await page.waitForFunction(() => /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(document.getElementById('stage-badge').textContent), null, { timeout: 5000 }).catch(() => {}); await t.idle(); await page.waitForTimeout(300);
      const sailed = rec.afterSail = await t.snap(), sA = store.get(a.id), sB = store.get(b.id);
      rec.serverAfterSail = { aStep: sA.rounds[a.roundId].step, aRevision: sA.revision, aBalanceCents: sA.balanceCents, bStep: sB.rounds[b.roundId].step, bRevision: sB.revision, bBalanceCents: sB.balanceCents };
      check('Sail advances B\'s round on the server and leaves A untouched', rec.serverAfterSail.bStep === 1 && rec.serverAfterSail.bRevision === 2 && rec.serverAfterSail.aStep === 0 && rec.serverAfterSail.aRevision === 1 && rec.serverAfterSail.aBalanceCents === 97000, rec.serverAfterSail);
      check('after Sail: B\'s state is shown without an error', sailed.balance === '$997.00' && sailed.round === roundLabel(b.roundId) && /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(sailed.stage) && !/not found|another action/i.test(sailed.toast), { balance: sailed.balance, round: sailed.round, stage: sailed.stage, toast: sailed.toast });
    });

    // M-02 guard: an unchanged session read leaves the page and the player's typing alone, and a newer revision of the
    // same session (changed in another tab) is still applied without replacing the typed bet.
    await scenario('M-02 same-session polling keeps the page and the player\'s input', view, async (rec, check) => {
      const t = rec.t = await open(view), { page } = t; await betSession(t);
      await page.click('#sail-button'); await page.waitForFunction(() => /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(document.getElementById('stage-badge').textContent)); await t.idle();
      if (await page.isVisible('#collect-all')) { await page.click('#collect-all'); await t.idle(); }
      await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Voyage settled');
      await page.click('#sail-button'); await page.fill('#bet-amount', '45.67'); // "New voyage", then typing the next bet
      await page.evaluate(() => { window.renders = 0; new MutationObserver(() => window.renders++).observe(document.getElementById('cargo-grid'), { childList: true }); });
      const before = rec.typing = await t.snap();
      await page.waitForResponse(r => r.url() === origin + '/api/session' && r.request().method() === 'GET', { timeout: POLL_MS + 3000 }); await page.waitForTimeout(600);
      const same = rec.afterSamePoll = { ...(await t.snap()), renders: await page.evaluate(() => window.renders) };
      check('unchanged poll: no re-render, typed bet and focus kept', same.renders === 0 && same.bet === '45.67' && same.focus === 'bet-amount', { renders: same.renders, bet: same.bet, focus: same.focus });
      check('unchanged poll: same balance and round, no notice', same.balance === before.balance && same.round === before.round && !/synchronized|different demo session/i.test(same.toast), { balance: same.balance, round: same.round, toast: same.toast });
      const other = apiClient(await t.cookie()), current = await other.get('/api/session');
      await other.post('/api/reset', { actionId: randomUUID(), revision: current.session.revision }); // another tab of the same session refills
      await page.waitForResponse(r => r.url() === origin + '/api/session' && r.request().method() === 'GET', { timeout: POLL_MS + 3000 });
      await t.balance('$1,000.00', 3000).catch(() => {}); await page.waitForTimeout(300);
      const synced = rec.afterSameSessionChange = await t.snap();
      check('same-session change: the new balance is shown as a synchronisation, not a replacement', synced.balance === '$1,000.00' && /synchronized/i.test(synced.toast) && !/different demo session/i.test(synced.toast), { balance: synced.balance, toast: synced.toast });
      check('same-session change: typed bet and focus kept', synced.bet === '45.67' && synced.focus === 'bet-amount', { bet: synced.bet, focus: synced.focus });
    });
  }
} finally { await browser.close(); await new Promise(r => app.close(r)); store.release(); fs.rmSync(dataDir, { recursive: true, force: true }); }
const git = (...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim(); } catch { return null; } };
// The code under test, by content: the results can be generated before the code is committed.
const tested = Object.fromEntries(['public/app.js', 'server/app.js', 'server/store.js', 'server/game.js'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const out = { meta: { script: 'audit/browser-phase4a3.mjs', root, rootHead: git('rev-parse', 'HEAD'), rootUncommitted: git('status', '--porcelain', '--untracked-files=no')?.split('\n').filter(Boolean) ?? null, sha256: tested, node: process.version, chromium: browser.version(), generatedAt: new Date().toISOString(), reducedMotion: true, views: views.map(v => ({ name: v.name, ...v.viewport })) },
  pass: results.length > 0 && results.every(r => r.ok), summary: { scenarios: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.scenario + ' (' + r.view + ')') }, results };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`${out.pass ? 'PASS' : 'FAIL'} phase 4A.3 browser checks: ${out.summary.passed}/${results.length} → ${outFile}`);
process.exitCode = out.pass ? 0 : 1;
