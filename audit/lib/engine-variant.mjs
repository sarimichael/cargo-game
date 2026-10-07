// Loads an isolated copy of the engine (server/game.js, server/fairness.js, public/math.js)
// plus the hosted Worker and the proof verifier from a temporary directory, with a text
// transform applied to math.js. This models a later deployment whose payout table
// differs, without touching the real files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function loadEngineVariant(transformMath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-engine-'));
  fs.mkdirSync(path.join(dir, 'server')); fs.mkdirSync(path.join(dir, 'public'));
  for (const f of ['server/game.js', 'server/fairness.js', 'server/protocol.js', 'server/worker.js', 'public/fairness.js']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  const math = fs.readFileSync(path.join(root, 'public/math.js'), 'utf8'), changed = transformMath(math);
  if (changed === math) throw new Error('engine variant transform did not change math.js');
  fs.writeFileSync(path.join(dir, 'public/math.js'), changed);
  try {
    const load = f => import(pathToFileURL(path.join(dir, f)).href);
    return { game: await load('server/game.js'), math: await load('public/math.js'), verifier: await load('public/fairness.js'), worker: (await load('server/worker.js')).default };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
