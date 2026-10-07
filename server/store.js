import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory) {
    this.directory = directory; this.file = path.join(directory, 'state.json');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, sessions: {} };
    if (this.state.version !== 1 || !this.state.sessions) throw new Error('Unrecognized saved game data.');
  }
  get(id) { return this.state.sessions[id] ?? null; }
  // One synchronous transaction: disk succeeds before memory is replaced.
  // This reference store is deliberately single-process and local-only.
  transaction(fn) {
    const next = structuredClone(this.state), result = fn(next);
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, this.file); this.state = next;
    return result;
  }
}
