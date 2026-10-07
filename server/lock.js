// Exclusive ownership of a local data directory by one process (audit finding F07).
// The lock is a small JSON file next to state.json: { pid, hostname, token, startedAt }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class DirectoryLockedError extends Error {
  constructor(message, owner = null) { super(message); this.code = 'DATA_DIRECTORY_LOCKED'; this.owner = owner; }
}
const LOCK_NAME = 'state.lock';
const UNREADABLE_GRACE_MS = 10000; // an unreadable lock younger than this may still be being written
const heldTokens = new Set();      // tokens of locks held by this process

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } // EPERM: exists, not ours
}
function readOwner(file) {
  try { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); return owner && typeof owner === 'object' ? owner : { unreadable: true }; }
  catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
}
// A lock is stale only when its owner is provably gone. Anything uncertain counts as live.
function isStale(owner, file) {
  if (owner.unreadable || typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    try { return Date.now() - fs.statSync(file).mtimeMs > UNREADABLE_GRACE_MS; } catch { return false; }
  }
  if (owner.hostname !== os.hostname()) return false; // cannot check a process on another machine
  // Our own PID but not a lock we hold: left by an earlier process that had the same PID
  // (typical for PID 1 in containers). Another Store in this process holds its token in heldTokens.
  if (owner.pid === process.pid) return !heldTokens.has(owner.token);
  return !processAlive(owner.pid);
}
// Create the lock with its full contents in one step; never overwrite an existing lock.
function create(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  try { fs.linkSync(temporary, file); return true; }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
    // File systems without hard links: exclusive create, then write (covered by UNREADABLE_GRACE_MS).
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (inner) { if (inner.code === 'EEXIST') return false; throw inner; }
    try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
    return true;
  } finally { fs.rmSync(temporary, { force: true }); }
}
function describe(owner, file) {
  const who = owner && !owner.unreadable ? `process ${owner.pid} on ${owner.hostname}, started ${owner.startedAt}` : 'another process';
  return `Cargo is already running with this save folder (${who}). Close it first, or set CARGO_DATA_DIR to use a separate folder. ` +
    `If you are certain no Cargo server is using it, delete ${file} and try again.`;
}

export function acquireDirectoryLock(directory) {
  const file = path.join(directory, LOCK_NAME), token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, hostname: os.hostname(), token, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 8; attempt++) {
    if (create(file, content)) { heldTokens.add(token); return handle(file, token); }
    const owner = readOwner(file);
    if (owner === null) continue; // released between our attempts
    if (!isStale(owner, file)) throw new DirectoryLockedError(describe(owner, file), owner);
    // Move the stale lock aside. Rename is atomic, so only one contender succeeds per lock file.
    const aside = `${file}.stale-${token}`;
    try { fs.renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const moved = readOwner(aside);
    if (moved?.token !== owner.token) {
      // Between our read and the rename another process created a fresh lock and we moved it.
      // Put it back without overwriting anything; if that is impossible, its owner's fencing check stops it writing.
      try { fs.linkSync(aside, file); } catch { if (!fs.existsSync(file)) { try { fs.renameSync(aside, file); } catch {} } }
    }
    fs.rmSync(aside, { force: true });
  }
  throw new DirectoryLockedError(describe(readOwner(file), file));
}

function handle(file, token) {
  return {
    file, token,
    // Fencing check before every write: refuse if the lock file no longer carries our token.
    assertHeld() {
      const owner = readOwner(file);
      if (owner?.token !== token) throw new DirectoryLockedError('This process no longer owns the save folder, so it will not write to it.', owner);
    },
    // Remove the lock only if it is still ours; never delete another process's lock.
    release() {
      if (!heldTokens.delete(token)) return;
      if (readOwner(file)?.token === token) fs.rmSync(file, { force: true });
    }
  };
}
