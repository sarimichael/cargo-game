// Real-browser check of the changed client modules (public/fairness.js, public/math.js)
// through the actual UI and local server, on desktop and phone viewports.
//
// Usage: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node audit/browser-check.mjs [--out audit/results/browser.json]
// Requires Playwright with a Chromium build (not a project dependency). Uses a temporary
// data directory, so no real wallet file is touched.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const outFile = arg('out', path.join(root, 'audit/results/browser.json'));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const port = 4300 + Math.floor(Math.random() * 500), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-browser-'));
const server = spawn(process.execPath, ['server/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), CARGO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { server.stdout.on('data', d => String(d).includes('Cargo is ready') && resolve()); server.on('exit', c => reject(new Error('server exited ' + c))); setTimeout(() => reject(new Error('server start timeout')), 10000); });
const url = `http://127.0.0.1:${port}/`, browser = await chromium.launch(), results = [];
try {
  for (const view of [{ name: 'desktop', viewport: { width: 1440, height: 900 } }, { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]) {
    const context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.hasTouch, reducedMotion: 'reduce' });
    const page = await context.newPage(), problems = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text()); });
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    await page.goto(url); await page.waitForSelector('#sail-button:not([disabled])');
    await page.fill('#bet-amount', '3.01');
    let actions = 0;
    for (; actions < 40; actions++) {
      if (await page.isVisible('#verify-result')) break;
      if (await page.isVisible('#collect-all') && await page.isEnabled('#collect-all')) await page.click('#collect-all');
      else if (await page.isEnabled('#sail-button')) await page.click('#sail-button');
      await page.waitForTimeout(250);
    }
    await page.click('#verify-result'); await page.waitForSelector('#verify-proof:not([disabled])'); await page.click('#verify-proof');
    await page.waitForSelector('#proof-result:not([hidden])');
    const uiVerify = { text: await page.textContent('#proof-result'), error: await page.evaluate(() => document.getElementById('proof-result').classList.contains('error')) };
    // The same modules, loaded by the browser, checked directly against the server's settled round.
    const modules = await page.evaluate(async () => {
      const { MODES } = await import('/math.js'), { verifyRound } = await import('/fairness.js');
      const s = await (await fetch('/api/session')).json(), round = (await (await fetch('/api/rounds/' + s.round.id)).json()).round;
      const tamper = async f => { const p = structuredClone(round); f(p); return (await verifyRound(p)).valid; };
      let frozen = true; try { MODES.easy.payouts[0] = 1; frozen = MODES.easy.payouts[0] === 103; } catch { frozen = MODES.easy.payouts[0] === 103; }
      return { roundStatus: round.status, genuine: (await verifyRound(round)).valid, extraField: await tamper(p => { p.bonusCents = 1; }), duplicateContainer: await tamper(p => { p.containers.push(structuredClone(p.containers[0])); }),
        multiplier: await tamper(p => { p.multiplier100 += 1; }), payoutTableFrozen: frozen && Object.isFrozen(MODES.easy.payouts) };
    });
    const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    await page.screenshot({ path: path.join(os.tmpdir(), `cargo-${view.name}.png`) });
    results.push({ view: view.name, actions, uiVerify, modules, layout, noHorizontalOverflow: layout.scrollWidth <= layout.innerWidth, consoleProblems: problems,
      ok: !uiVerify.error && /verified/i.test(uiVerify.text) && modules.genuine && !modules.extraField && !modules.duplicateContainer && !modules.multiplier && modules.payoutTableFrozen && layout.scrollWidth <= layout.innerWidth && problems.length === 0 });
    await context.close();
  }
} finally { await browser.close(); server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
const out = { meta: { script: 'audit/browser-check.mjs', node: process.version, chromium: browser.version(), generatedAt: new Date().toISOString(), reducedMotion: true }, pass: results.every(r => r.ok), results };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`${out.pass ? 'PASS' : 'FAIL'} browser check (${results.map(r => `${r.view}:${r.ok ? 'ok' : 'FAIL'}`).join(', ')}) → ${outFile}`);
process.exitCode = out.pass ? 0 : 1;
