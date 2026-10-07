import fs from 'node:fs';
import path from 'node:path';
import { acquireDirectoryLock } from './lock.js';

export class Store {
  constructor(directory) {
    this.directory = directory; this.file = path.join(directory, 'state.json'); this.lock = null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.load();
  }
  load() {
    const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, sessions: {} };
    if (state.version !== 1 || !state.sessions) throw new Error('Unrecognized saved game data.');
    return state;
  }
  // Take exclusive ownership of the folder (one writing process at a time) and reload,
  // because another process may have written since this store was constructed.
  acquire() {
    if (!this.lock) { this.lock = acquireDirectoryLock(this.directory); try { this.state = this.load(); } catch (error) { this.release(); throw error; } }
    return this;
  }
  release() { this.lock?.release(); this.lock = null; }
  get(id) { return this.state.sessions[id] ?? null; }
  // One synchronous transaction: disk succeeds before memory is replaced.
  // This reference store is local-only; the folder lock keeps it single-process.
  transaction(fn) {
    this.acquire(); this.lock.assertHeld();
    const next = structuredClone(this.state), result = fn(next);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, this.file); this.state = next;
    return result;
  }
}
