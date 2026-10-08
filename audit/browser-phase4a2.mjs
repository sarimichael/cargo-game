// Phase 4A.2 real-browser regression checks: browser-state reliability (M1, M2, M3), desktop and phone.
//
//   M1  a delayed GET /api/session response must never overwrite a newer acknowledged action, and a delayed
//       failure must not mark a working connection as lost; a legitimate session replacement is still shown.
//   M2  an already-loaded session that disappears during an action is quarantined: its balance is never shown
//       again, the recovery control survives dialog closure and unrelated input, and nothing is auto-created.
//   M3  after a start whose outcome is unknown, a second start is possible only after a completed read.
//
// Usage: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node audit/browser-phase4a2.mjs [--root <checkout>] [--out <file>]
// --root runs the server and client of another checkout (used for the red baseline against Phase 4A.1).
// Uses a temporary data directory, so no real wallet file is touched.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const root = path.resolve(arg('root', here)), outFile = arg('out', path.join(here, 'audit/results/browser-phase4a2.json'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const port = 4800 + Math.floor(Math.random() * 500), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-browser-4a2-'));
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), CARGO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { server.stdout.on('data', d => String(d).includes('Cargo is ready') && resolve()); server.on('exit', c => reject(new Error('server exited ' + c))); setTimeout(() => reject(new Error('server start timeout')), 10000); });
const url = `http://127.0.0.1:${port}/`, browser = await chromium.launch(), results = [];
const views = [{ name: 'desktop', viewport: { width: 1440, height: 900 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }];
const sessionsOnDisk = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).sessions).length;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const missingCookie = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

// One page with scripted interception of /api/session. Holds are consumed in order:
//   GET  { kind: 'delay', fetched, released, thenFail } — the server answers now (old state); the browser receives it later
//   GET  { kind: 'fail' } — network failure before the server is reached
//   POST { kind: 'fail' } — network failure before the server is reached (nothing created)
//   POST { kind: 'lost-body' } — the server commits and the cookie arrives, but the body is lost (outcome unknown)
async function open(view, { cookie } = {}) {
  const context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch, reducedMotion: 'reduce' });
  if (cookie) await context.addCookies([{ name: 'cargo_session', value: cookie, url }]);
  const page = await context.newPage(), problems = [], log = [], ctl = { gets: [], posts: [] }, counts = { get: 0, post: 0 };
  page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource: (the server responded with a status of (404|409)|net::ERR_FAILED)/.test(m.text())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  const label = r => r.method() + ' ' + new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/, ':id');
  page.on('response', r => { if (r.url().includes('/api/')) log.push(label(r.request()) + ' ' + r.status()); });
  page.on('requestfailed', r => { if (r.url().includes('/api/')) log.push(label(r) + ' failed'); });
  await page.route('**/api/session', async route => {
    if (route.request().method() === 'GET') {
      counts.get++; const hold = ctl.gets.shift();
      if (!hold) return route.continue();
      if (hold.kind === 'fail') return route.abort('failed');
      const response = await route.fetch(); hold.fetched(); await hold.released;
      return hold.thenFail ? route.abort('failed') : route.fulfill({ response });
    }
    counts.post++; const hold = ctl.posts.shift();
    if (!hold) return route.continue();
    if (hold.kind === 'fail') return route.abort('failed');
    const response = await route.fetch();
    return route.fulfill({ response, body: '{"trunc' });
  });
  const snap = () => page.evaluate(() => {
    const $ = id => document.getElementById(id), start = $('start-new-session');
    return { balance: $('balance').textContent, status: $('save-status').textContent, reopen: !!$('reopen-recovery'), reopenVisible: !!$('reopen-recovery')?.getClientRects().length,
      open: $('modal').open, title: $('modal-title').textContent, round: $('round-label').textContent, sailDisabled: $('sail-button').disabled, toast: $('toast').hidden ? '' : $('toast').textContent,
      start: start && { disabled: start.disabled, text: start.textContent }, retry: $('retry-session') && { disabled: $('retry-session').disabled },
      overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  const idle = () => page.waitForFunction(() => document.getElementById('status-text').textContent !== 'Action in progress');
  const balance = text => page.waitForFunction(t => document.getElementById('balance').textContent === t, text, { timeout: 8000 });
  const focusEvents = () => page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  return { context, page, problems, log, ctl, counts, snap, idle, balance, focusEvents };
}
// fn records its observations in rec, so a step that times out (as on the unfixed client) still leaves evidence.
async function scenario(name, view, fn) {
  const rec = {}; let detail;
  try { const result = await fn(rec); detail = { ...rec, ...result }; } catch (error) { detail = { ok: false, error: error.message.split('\n')[0], ...rec }; await rec.close?.().catch(() => {}); }
  delete detail.close; if (detail.t) { detail.log = detail.t.log; detail.consoleProblems = detail.t.problems; delete detail.t; }
  results.push({ scenario: name, view: view.name, ...detail });
  console.error(`${detail.ok ? 'ok  ' : 'FAIL'} ${name} (${view.name})${detail.error ? ' — ' + detail.error : ''}`);
}

try {
  for (const view of views) {
    // M1a: a read sent before an action and delivered after it must be discarded.
    await scenario('M1 delayed read after a newer action', view, async rec => {
      const t = rec.t = await open(view); const { page } = t; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
      const fetched = deferred(), released = deferred(); t.ctl.gets.push({ kind: 'delay', fetched: fetched.resolve, released: released.promise });
      await t.focusEvents(); await fetched.promise; // the server has answered with the pre-bet state
      await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      const afterAction = rec.afterAction = await t.snap();
      released.resolve(); await page.waitForTimeout(700);
      const afterStaleRead = rec.afterStaleRead = await t.snap();
      // A delayed read that finally fails must not report the (working) connection as lost.
      const fetched2 = deferred(), released2 = deferred(); t.ctl.gets.push({ kind: 'delay', fetched: fetched2.resolve, released: released2.promise, thenFail: true });
      await t.focusEvents(); await fetched2.promise;
      await page.click('#sail-button'); await page.waitForFunction(() => /STOP 01|VOYAGE COMPLETE|ICEBERG/.test(document.getElementById('stage-badge').textContent)); await t.idle();
      const afterAction2 = rec.afterAction2 = await t.snap();
      released2.resolve(); await page.waitForTimeout(700);
      const afterStaleFailure = rec.afterStaleFailure = await t.snap(); await t.context.close();
      const ok = afterAction.balance === '$970.00' && afterStaleRead.balance === '$970.00' && /^ROUND /.test(afterStaleRead.round) && /saved/i.test(afterStaleRead.status)
        && /saved/i.test(afterStaleFailure.status) && afterStaleFailure.balance === afterAction2.balance && !afterStaleFailure.sailDisabled === !afterAction2.sailDisabled && t.problems.length === 0;
      return { ok, afterAction, afterStaleRead, afterAction2, afterStaleFailure };
    });
    // M1b: the same race through the 12-second background poll.
    await scenario('M1 delayed poll after a newer action', view, async rec => {
      const t = rec.t = await open(view); const { page } = t; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
      const fetched = deferred(), released = deferred(); t.ctl.gets.push({ kind: 'delay', fetched: fetched.resolve, released: released.promise });
      await Promise.race([fetched.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('poll did not fire within 15 s')), 15000))]);
      await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      released.resolve(); await page.waitForTimeout(700);
      const afterStalePoll = rec.afterStalePoll = await t.snap(); await t.context.close();
      const ok = afterStalePoll.balance === '$970.00' && /^ROUND /.test(afterStalePoll.round) && !/synchronized/i.test(afterStalePoll.toast) && t.problems.length === 0;
      return { ok, afterStalePoll };
    });
    // Guard: a legitimate replacement (another tab of this browser started a different session) is still shown.
    await scenario('M1 legitimate session replacement is shown', view, async rec => {
      const t = rec.t = await open(view); const { page } = t; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
      await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      const other = await fetch(url + 'api/session'), replacement = /cargo_session=([a-f0-9]{64})/.exec(other.headers.get('set-cookie'))[1];
      await t.context.addCookies([{ name: 'cargo_session', value: replacement, url }]);
      await t.focusEvents(); await t.balance('$1,000.00'); await t.idle();
      const replaced = rec.replaced = await t.snap();
      await page.fill('#bet-amount', '30.00'); await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      const usable = rec.usable = await t.snap(); await t.context.close();
      const ok = replaced.round === 'PLAY-MONEY PROTOTYPE' && /saved/i.test(replaced.status) && /^ROUND /.test(usable.round) && /saved/i.test(usable.status) && t.problems.length === 0;
      return { ok, replaced, usable };
    });
    // M2: the loaded session disappears on the server during an action.
    await scenario('M2 session disappears during an action', view, async rec => {
      const t = rec.t = await open(view); const { page } = t, checks = rec.checks = {}; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])'); await page.fill('#bet-amount', '30.00');
      await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      const before = rec.sessionsBefore = sessionsOnDisk();
      // The server no longer has this browser's session (identical responses to a deleted row or state entry).
      await t.context.addCookies([{ name: 'cargo_session', value: missingCookie(), url }]);
      await page.evaluate(() => { window.balanceTexts = []; const b = document.getElementById('balance'); new MutationObserver(() => window.balanceTexts.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true }); });
      await page.click('#sail-button'); await page.waitForSelector('#modal[open] #start-new-session'); await t.idle(); await page.waitForTimeout(300);
      checks.afterAction = await t.snap();
      await page.click('#close-modal'); await page.waitForTimeout(300); checks.afterClose = await t.snap();
      // Unrelated input: typing a bet, halving/doubling, picking a difficulty, keyboard focus moves, focus events.
      const getsBefore = t.counts.get;
      await page.evaluate(() => {
        const input = document.getElementById('bet-amount'); input.value = '45.00'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('blur'));
        for (const id of ['half-bet', 'double-bet']) document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        document.querySelector('[data-mode="hard"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
      await t.focusEvents(); await page.waitForTimeout(400);
      checks.afterInputs = { ...(await t.snap()), extraGets: t.counts.get - getsBefore, sessions: sessionsOnDisk() };
      await page.screenshot({ path: path.join(os.tmpdir(), `cargo-4a2-m2-closed-${view.name}.png`) }); // recovery control after closing and input
      // Keyboard access to the recovery control.
      await page.focus('#reopen-recovery'); await page.keyboard.press('Enter'); await page.waitForSelector('#modal[open] #start-new-session');
      checks.reopened = await t.snap();
      await page.click('#start-new-session'); await t.balance('$1,000.00'); await page.waitForFunction(() => !document.getElementById('modal').open); await t.idle();
      checks.recovered = { ...(await t.snap()), posts: t.counts.post, sessions: sessionsOnDisk() };
      await page.fill('#bet-amount', '30.00'); await page.click('#sail-button'); await t.balance('$970.00'); await t.idle();
      checks.usable = await t.snap();
      // Every balance shown from the moment the session was reported missing until the new session loaded.
      const texts = await page.evaluate(() => window.balanceTexts), firstDash = texts.indexOf('—'), afterDash = texts.slice(Math.max(firstDash, 0));
      const untilRecovered = afterDash.slice(0, afterDash.includes('$1,000.00') ? afterDash.indexOf('$1,000.00') : undefined);
      checks.balanceTexts = texts; await t.context.close();
      const c = checks, ok = c.afterAction.balance === '—' && c.afterAction.open && c.afterAction.title === 'Saved session not found'
        && firstDash >= 0 && !untilRecovered.includes('$970.00')
        && !c.afterClose.open && c.afterClose.reopen && c.afterClose.reopenVisible && c.afterClose.balance === '—'
        && c.afterInputs.reopen && c.afterInputs.reopenVisible && c.afterInputs.balance === '—' && /not found/i.test(c.afterInputs.status) && c.afterInputs.sailDisabled && !c.afterInputs.open && c.afterInputs.extraGets === 0 && c.afterInputs.sessions === before
        && c.reopened.open && c.reopened.title === 'Saved session not found'
        && c.recovered.posts === 1 && c.recovered.sessions === before + 1 && /saved/i.test(c.recovered.status) && c.recovered.round === 'PLAY-MONEY PROTOTYPE'
        && /^ROUND /.test(c.usable.round) && !c.usable.overflow && t.problems.length === 0;
      return { ok, sessionsBefore: before, checks };
    });
    // M3a: a start that fails before reaching the server. A second start needs a completed read first.
    await scenario('M3 second start only after a completed read', view, async rec => {
      const t = rec.t = await open(view, { cookie: missingCookie() }); const { page } = t, checks = rec.checks = {}; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#start-new-session:not([disabled])');
      const before = rec.sessionsBefore = sessionsOnDisk();
      t.ctl.posts.push({ kind: 'fail' }); t.ctl.gets.push({ kind: 'fail' });
      await page.click('#start-new-session'); await page.waitForSelector('.toast.error'); await page.waitForTimeout(500);
      checks.afterUnknownStart = await t.snap();
      await page.click('#start-new-session', { timeout: 1000 }).catch(() => {}); await page.waitForTimeout(300);
      checks.postsAfterEarlyClick = t.counts.post;
      await page.click('#retry-session'); await page.waitForSelector('#start-new-session:not([disabled])', { timeout: 4000 });
      checks.afterConfirmedMissing = await t.snap();
      await page.click('#start-new-session'); await t.balance('$1,000.00'); await t.idle();
      checks.final = { ...(await t.snap()), posts: t.counts.post, sessions: sessionsOnDisk() };
      const order = t.log.filter(l => l.startsWith('GET /api/session') || l.startsWith('POST /api/session')), firstPost = order.indexOf('POST /api/session failed'), secondPost = order.indexOf('POST /api/session 200');
      await t.context.close();
      const c = checks, ok = c.afterUnknownStart.start?.disabled === true && c.afterUnknownStart.retry?.disabled === false && c.postsAfterEarlyClick === 1
        && firstPost >= 0 && secondPost > firstPost && order.slice(firstPost, secondPost).includes('GET /api/session 404')
        && c.final.posts === 2 && c.final.sessions === before + 1 && /saved/i.test(c.final.status) && t.problems.length === 0;
      return { ok, sessionsBefore: before, checks, order };
    });
    // M3b: the server commits the start and the cookie arrives, but the response body is lost.
    await scenario('M3 lost start response is found by a read, not a second start', view, async rec => {
      const t = rec.t = await open(view, { cookie: missingCookie() }); const { page } = t; rec.close = () => t.context.close();
      await page.goto(url); await page.waitForSelector('#start-new-session:not([disabled])');
      const before = rec.sessionsBefore = sessionsOnDisk();
      t.ctl.posts.push({ kind: 'lost-body' });
      await page.click('#start-new-session');
      const loaded = await t.balance('$1,000.00').then(() => true, () => false); await page.waitForTimeout(300);
      const final = rec.final = { ...(await t.snap()), posts: t.counts.post, sessions: sessionsOnDisk() }; await t.context.close();
      const ok = loaded && !final.open && /saved/i.test(final.status) && final.posts === 1 && final.sessions === before + 1 && t.problems.length === 0;
      return { ok, sessionsBefore: before, final };
    });
  }
} finally { await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
const out = { meta: { script: 'audit/browser-phase4a2.mjs', root, node: process.version, chromium: browser.version(), generatedAt: new Date().toISOString(), reducedMotion: true }, pass: results.every(r => r.ok), results };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`${out.pass ? 'PASS' : 'FAIL'} phase 4A.2 browser checks: ${results.filter(r => r.ok).length}/${results.length} → ${outFile}`);
process.exitCode = out.pass ? 0 : 1;
