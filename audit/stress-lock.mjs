// Stress test of the save-folder lock (phase 4A.1, finding F07 / review R1–R4).
//
// Usage: node audit/stress-lock.mjs [--rounds 40] [--contenders 12] [--out audit/results/lock-stress.json]
//
// Each round: a real owner process takes the lock and is killed with SIGKILL (a genuine crash), then N contender
// processes, released at the same instant by a start barrier, race to recover it. Owners keep holding until every
// contender has finished, and each owner checks its lock every 5 ms while it holds, so a takeover of a live owner
// is detected rather than hidden by timing. Alternate rounds race against a LIVE owner instead (all must be refused).
// Safety properties counted: owners per round (must be exactly 1), owners that lost a lock they held (must be 0),
// unexpected errors (must be 0), and debris left after everyone released (must be none).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (n, f) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : f; };
const rounds = Number(arg('rounds', 40)), n = Number(arg('contenders', 12)), outFile = arg('out', path.join(root, 'audit/results/lock-stress.json'));
const fixture = name => path.join(root, 'audit/fixtures', name);
const waitFor = async (cond, ms = 30000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const exited = p => new Promise(r => (p.exitCode !== null || p.signalCode !== null) ? r() : p.on('exit', r));
const { acquireDirectoryLock } = await import(path.join(root, 'server/lock.js'));

async function crashOwner(dir) {
  const p = spawn(process.execPath, [fixture('lock-crash.mjs'), root, dir], { stdio: ['ignore', 'pipe', 'inherit'] }); let out = '';
  p.stdout.on('data', d => { out += d; }); await waitFor(() => out.includes('READY')); p.kill('SIGKILL'); await exited(p);
}
async function race(dir) {
  const signal = path.join(os.tmpdir(), 'cargo-stress-' + randomUUID()), startAt = Date.now() + 600, outs = Array(n).fill(null), procs = [];
  for (let i = 0; i < n; i++) {
    const p = spawn(process.execPath, [fixture('lock-contender.mjs'), root, dir, String(startAt), signal], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; }); p.on('exit', () => { outs[i] = o.trim(); }); procs.push(p);
  }
  const owners = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(signal) + '.owner.')).length;
  await waitFor(() => outs.filter(o => o !== null).length + owners() >= n);
  await new Promise(r => setTimeout(r, 100));
  fs.writeFileSync(signal, ''); await Promise.all(procs.map(exited));
  for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(path.basename(signal))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  return outs;
}

const tally = { crashRecovery: { rounds: 0, ownersPerRound: {}, lostWhileHeld: 0, errors: [] }, liveOwner: { rounds: 0, wronglyAcquired: 0, ownerLost: 0, errors: [] }, debris: [] };
const started = Date.now();
for (let r = 0; r < rounds; r++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-stress-dir-'));
  try {
    if (r % 2 === 0) {
      await crashOwner(dir); const outs = await race(dir), owners = outs.filter(o => o.startsWith('OWNER')).length;
      tally.crashRecovery.rounds++; tally.crashRecovery.ownersPerRound[owners] = (tally.crashRecovery.ownersPerRound[owners] || 0) + 1;
      tally.crashRecovery.lostWhileHeld += outs.filter(o => o === 'OWNER:LOST').length;
      tally.crashRecovery.errors.push(...outs.filter(o => !/^(OWNER:HELD|OWNER:LOST|REFUSED)$/.test(o)));
    } else {
      const owner = await acquireDirectoryLock(dir); const outs = await race(dir);
      tally.liveOwner.rounds++; tally.liveOwner.wronglyAcquired += outs.filter(o => o.startsWith('OWNER')).length;
      tally.liveOwner.errors.push(...outs.filter(o => !/^(OWNER:HELD|OWNER:LOST|REFUSED)$/.test(o)));
      try { owner.assertHeld(); } catch { tally.liveOwner.ownerLost++; } owner.release();
    }
    const left = fs.readdirSync(dir).filter(f => f !== 'state.json'); if (left.length) tally.debris.push({ round: r, left });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const pass = (tally.crashRecovery.ownersPerRound[1] || 0) === tally.crashRecovery.rounds && tally.crashRecovery.lostWhileHeld === 0 && tally.crashRecovery.errors.length === 0
  && tally.liveOwner.wronglyAcquired === 0 && tally.liveOwner.ownerLost === 0 && tally.liveOwner.errors.length === 0 && tally.debris.length === 0;
const out = { meta: { script: 'audit/stress-lock.mjs', node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, rounds, contenders: n, seconds: Math.round((Date.now() - started) / 1000), generatedAt: new Date().toISOString() }, pass, tally };
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.error(`${pass ? 'PASS' : 'FAIL'} lock stress: ${JSON.stringify(tally)} → ${outFile}`);
process.exitCode = pass ? 0 : 1;
