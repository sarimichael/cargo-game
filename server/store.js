import fs from 'node:fs';
import path from 'node:path';
import { acquireDirectoryLock, acquireDirectoryLockSync } from './lock.js';

export class Store {
  constructor(directory) {
    this.directory = directory; this.file = path.join(directory, 'state.json'); this.lock = null;
    this.onLost = null; this.lostError = null; this.watcher = null;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.load();
  }
  load() {
    const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, sessions: {} };
    if (state.version !== 1 || !state.sessions) throw new Error('Unrecognized saved game data.');
    return state;
  }
  // Take exclusive ownership of the folder (one process at a time, see lock.js) and reload, because another
  // process may have written since this store was constructed. The server awaits this before listening.
  async acquire() {
    if (!this.lock) this.adopt(await acquireDirectoryLock(this.directory));
    await this.lock.ready;
    return this;
  }
  adopt(lock) {
    this.lock = lock;
    try {
      // Each owner writes through its own temporary file; files left by an interrupted earlier owner are removed.
      for (const name of fs.readdirSync(this.directory)) if (/^state\.json(\.[0-9a-f]{12})?\.tmp$/.test(name)) fs.rmSync(path.join(this.directory, name), { force: true });
      this.temporary = `${this.file}.${lock.token.replace(/-/g, '').slice(0, 12)}.tmp`;
      this.state = this.load();
    } catch (error) { this.release(); throw error; }
  }
  release() { clearInterval(this.watcher); this.lock?.release(); this.lock = null; }
  // Fencing: once this process no longer owns the folder it must not serve or write saved state.
  ensureOwned() {
    if (this.lostError) throw this.lostError;
    if (!this.lock) return;
    try { this.lock.assertHeld(); }
    catch (error) {
      this.lostError = error; this.state = { version: 1, sessions: {} }; // drop the in-memory copy: it may be stale
      try { this.onLost?.(error); } catch {}
      throw error;
    }
  }
  // Also notice a lost lock between requests.
  watch(intervalMs = 1000) {
    clearInterval(this.watcher);
    this.watcher = setInterval(() => { try { this.ensureOwned(); } catch {} }, intervalMs); this.watcher.unref();
    return this;
  }
  get(id) { this.ensureOwned(); return this.state.sessions[id] ?? null; }
  // One synchronous transaction: disk succeeds before memory is replaced.
  // This reference store is local-only; the folder lock keeps it single-process.
  transaction(fn) {
    if (!this.lock && !this.lostError) this.adopt(acquireDirectoryLockSync(this.directory));
    this.ensureOwned();
    const next = structuredClone(this.state), result = fn(next);
    fs.writeFileSync(this.temporary, JSON.stringify(next), { mode: 0o600 });
    try { this.ensureOwned(); } catch (error) { fs.rmSync(this.temporary, { force: true }); throw error; } // re-check just before replacing
    fs.renameSync(this.temporary, this.file); this.state = next;
    return result;
  }
}
