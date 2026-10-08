// Exclusive ownership of a local save folder by one process (audit finding F07; corrected in phase 4A.1).
//
// Supported: one machine, a local file system, any number of processes, threads or PID namespaces on that
// machine's kernel. Not supported: a folder shared between machines (network or cloud-synced file systems);
// there the lock still refuses a second server but never recovers automatically. This is not a distributed lock.
//
// state.lock holds { version: 2, pid, hostname, bootId, pidNs, token, endpoint, startedAt } and is created
// atomically (it never exists half-written). Its owner proves it is alive by listening on `endpoint`, a Unix
// domain socket next to the lock (a named pipe on Windows). The kernel accepts connections to a listening socket
// even while the owner is busy, and refuses them once the owning process has gone, so "connection refused" is
// direct evidence of termination. No heartbeat, timeout or PID comparison is ever treated as proof on its own.
// Recovery of a dead owner's lock is serialized by state.lock.recover; anything uncertain refuses startup and
// asks for deliberate manual recovery.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class DirectoryLockedError extends Error {
  constructor(message, owner = null) { super(message); this.code = 'DATA_DIRECTORY_LOCKED'; this.owner = owner; }
}
export class OwnershipLostError extends Error {
  constructor(message) { super(message); this.code = 'OWNERSHIP_LOST'; }
}
const LOCK_NAME = 'state.lock', VERSION = 2, PROBE_TIMEOUT_MS = 2000;
const windows = process.platform === 'win32';
const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const link = file => { try { return fs.readlinkSync(file); } catch { return null; } };
// Identity of this machine's running kernel and this process's PID namespace (Linux; null elsewhere).
const identity = { hostname: os.hostname(), bootId: read('/proc/sys/kernel/random/boot_id'), pidNs: link('/proc/self/ns/pid') };
// File systems that can be shared between machines (Linux statfs magic numbers). A socket file there cannot
// prove anything about a process on another machine, so automatic recovery is disabled.
const SHARED_FILE_SYSTEMS = new Set([0x6969 /* nfs */, 0x517b /* smb */, 0xff534d42 /* cifs */, 0xfe534d42 /* smb2 */, 0x65735546 /* fuse, incl. virtiofs and sync clients */,
  0x01021997 /* 9p */, 0x00c36400 /* ceph */, 0x5346414f /* afs */, 0x6b414653 /* kafs */, 0x73757245 /* coda */, 0x564c /* ncp */, 0x7461636f /* ocfs2 */,
  0x01161970 /* gfs2 */, 0x786f4256 /* vboxsf */, 0x7c7c6673 /* prl_fs */, 0x47504653 /* gpfs */, 0x0bd00bd0 /* lustre */, 0xbacbacbc /* virtualbox shared folder */]);
function sharedFileSystem(directory) {
  if (process.platform !== 'linux') return false;
  try { return SHARED_FILE_SYSTEMS.has(Number(fs.statfsSync(directory).type)); } catch { return true; } // unknown: assume shared
}

const shortToken = token => token.replace(/-/g, '').slice(0, 12);
// Where the owner holding `token` listens. Derived from the folder and token, never taken from the lock file.
function endpointFor(directory, token) {
  const tag = shortToken(token);
  if (windows) return `\\\\?\\pipe\\cargo-${createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 24)}-${tag}`;
  const local = path.join(path.resolve(directory), `${LOCK_NAME}.${tag}.sock`);
  if (Buffer.byteLength(local) <= 100) return local; // Unix socket paths are limited to ~104–108 bytes
  return path.join(os.tmpdir(), `cargo-${createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16)}-${tag}.sock`);
}

function readOwner(file) {
  try { const owner = JSON.parse(fs.readFileSync(file, 'utf8')); return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : { unreadable: true }; }
  catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
}
const wellFormed = owner => owner && owner.version === VERSION && typeof owner.token === 'string' && /^[0-9a-f-]{36}$/.test(owner.token) &&
  Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string';

// Create `file` with its full contents in one step; never overwrite an existing file.
function create(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  try { fs.linkSync(temporary, file); return true; }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code)) throw error;
    // File systems without hard links: exclusive create, then write. A reader that sees it empty treats it as
    // unreadable, which always refuses (never recovers), so the gap cannot cause a takeover.
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); } catch (inner) { if (inner.code === 'EEXIST') return false; throw inner; }
    try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
    return true;
  } finally { fs.rmSync(temporary, { force: true }); }
}
// Remove `file` only if it still carries `token`. The file is moved aside first so the check applies to exactly
// the file removed; anything else is put back without overwriting.
function removeIfOwned(file, token) {
  if (readOwner(file)?.token !== token) return false;
  const aside = `${file}.${shortToken(randomUUID())}.removing`;
  try { fs.renameSync(file, aside); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const moved = readOwner(aside);
  if (moved?.token !== token) { try { fs.linkSync(aside, file); } catch {} fs.rmSync(aside, { force: true }); return false; }
  fs.rmSync(aside, { force: true });
  return true;
}

// Connect to an owner's endpoint: 'connected', 'refused' (no listener: the owning process has gone),
// 'missing' (no endpoint file) or 'unknown'.
function probe(endpoint) {
  return new Promise(resolve => {
    const socket = net.connect(endpoint); let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish('unknown'), PROBE_TIMEOUT_MS);
    socket.on('connect', () => finish('connected'));
    socket.on('error', error => finish(!windows && error.code === 'ECONNREFUSED' ? 'refused' : error.code === 'ENOENT' ? 'missing' : 'unknown'));
  });
}
const processGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };

// 'live', 'dead' (termination confirmed) or 'unknown'. Only 'dead' permits automatic recovery.
async function ownerStatus(owner, directory) {
  if (!wellFormed(owner)) return { status: 'unknown', reason: owner?.unreadable ? 'the lock file is unreadable or incomplete' : 'the lock file was written by an older version of Cargo or is damaged' };
  if (sharedFileSystem(directory)) return { status: 'unknown', reason: 'the save folder is on a network or shared file system, where Cargo cannot confirm whether the owner is still running' };
  const sameKernel = identity.bootId && owner.bootId ? identity.bootId === owner.bootId : !identity.bootId && !owner.bootId && owner.hostname === identity.hostname;
  if (!sameKernel) {
    // Same machine name, local file system, different boot: the machine restarted since the lock was taken.
    if (identity.bootId && owner.bootId && owner.hostname === identity.hostname) return { status: 'dead', reason: 'the computer has restarted since the lock was taken' };
    return { status: 'unknown', reason: `the lock belongs to ${owner.hostname}, which is not this computer` };
  }
  const endpoint = endpointFor(directory, owner.token);
  if (owner.endpoint !== undefined && owner.endpoint !== endpoint) return { status: 'unknown', reason: 'the lock names a different liveness endpoint' };
  let result = await probe(endpoint);
  // Refusal must be stable: on some platforms a momentarily full listen backlog is also refused.
  if (result === 'refused') { await new Promise(resolve => setTimeout(resolve, 50)); result = await probe(endpoint); }
  if (result === 'connected') return { status: 'live' };
  if (result === 'refused') return { status: 'dead', reason: 'its process has exited' };
  if (result === 'missing') {
    // The owner listens before (asynchronous start) or just after (lazy start) creating the lock. Without an
    // endpoint, fall back to the process ID only where it is meaningful: same kernel, same PID namespace, and not
    // this process (a worker thread or a second store in this process must never take this process's lock).
    const sameNamespace = identity.pidNs && owner.pidNs ? identity.pidNs === owner.pidNs : !identity.pidNs && !owner.pidNs;
    if (sameNamespace && owner.pid !== process.pid && processGone(owner.pid)) return { status: 'dead', reason: 'its process has exited' };
  }
  return { status: 'unknown', reason: 'Cargo could not confirm whether its owner is still running' };
}

function describe(owner, file, reason) {
  const who = owner && wellFormed(owner) ? `process ${owner.pid} on ${owner.hostname}, started ${owner.startedAt}` : 'another process';
  return `Cargo is already running with this save folder (${who})${reason ? '; ' + reason : ''}. Close it first, or set CARGO_DATA_DIR to use a separate folder. ` +
    `If you are certain no Cargo server is using this folder, delete ${file} and try again.`;
}
const lockedError = (owner, file, reason) => new DirectoryLockedError(describe(owner, file, reason), owner);

function listen(endpoint) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(connection => connection.destroy());
    server.once('error', reject);
    server.listen(endpoint, () => { server.removeListener('error', reject); server.on('error', () => {}); server.unref(); resolve(server); });
  });
}
const inode = endpoint => { if (windows) return null; try { return fs.statSync(endpoint).ino; } catch { return null; } };
const unavailable = (directory, error) => Object.assign(new Error(`Cargo could not lock its save folder ${directory}: ${error.message}`), { code: 'DATA_DIRECTORY_UNAVAILABLE', cause: error });

function lockContent(directory, token) {
  return JSON.stringify({ version: VERSION, pid: process.pid, hostname: identity.hostname, bootId: identity.bootId, pidNs: identity.pidNs, token, endpoint: endpointFor(directory, token), startedAt: new Date().toISOString() });
}

// Take the folder, recovering a lock whose owner has confirmed terminated. Resolves once this process is
// listening on its endpoint. Rejects with DATA_DIRECTORY_LOCKED (another owner, or uncertain) or
// DATA_DIRECTORY_UNAVAILABLE (the folder cannot be used).
export async function acquireDirectoryLock(directory) {
  const file = path.join(directory, LOCK_NAME), token = randomUUID(), endpoint = endpointFor(directory, token), content = lockContent(directory, token);
  let server;
  try { server = await listen(endpoint); } catch (error) { throw unavailable(directory, error); }
  const giveUp = error => { server.close(); if (!windows) fs.rmSync(endpoint, { force: true }); throw error; };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (create(file, content)) return handle(directory, file, token, endpoint, server);
      const owner = readOwner(file);
      if (owner === null) continue; // released between our attempts
      const { status, reason } = await ownerStatus(owner, directory);
      if (status !== 'dead') throw lockedError(owner, file, reason);
      if (await recover(directory, file, owner, token, content)) return handle(directory, file, token, endpoint, server);
    }
    throw lockedError(readOwner(file), file);
  } catch (error) { giveUp(error.code === 'DATA_DIRECTORY_LOCKED' ? error : unavailable(directory, error)); }
}

// Replace a dead owner's lock. Only one process may recover at a time; a recovery left unfinished (its
// process killed mid-way) blocks automatic recovery until someone removes state.lock.recover deliberately.
async function recover(directory, file, dead, token, content) {
  const mutex = file + '.recover';
  if (!create(mutex, JSON.stringify({ version: VERSION, pid: process.pid, hostname: identity.hostname, token, startedAt: new Date().toISOString() }))) {
    throw new DirectoryLockedError(`Another Cargo process is recovering this save folder, or a recovery was interrupted. Try again in a moment. ` +
      `If no Cargo server is starting, delete ${mutex} and try again.`, readOwner(mutex));
  }
  try {
    const current = readOwner(file);
    if (current === null) return create(file, content);           // removed meanwhile: an ordinary start
    if (current.token !== dead.token) return false;                // a new owner exists: re-evaluate it
    const confirmed = await ownerStatus(current, directory);       // re-confirm under the mutex
    if (confirmed.status !== 'dead') throw lockedError(current, file, confirmed.reason);
    if (!removeIfOwned(file, dead.token)) return false;
    if (!windows) { const old = endpointFor(directory, dead.token); if (old.startsWith(path.resolve(directory) + path.sep) || old.startsWith(os.tmpdir())) fs.rmSync(old, { force: true }); }
    return create(file, content); // false: a newcomer created a lock after the removal; it is the owner
  } finally { removeIfOwned(mutex, token); }
}

// Lazy, synchronous acquisition (used when a Store writes before acquire() was awaited). It never recovers:
// any existing lock refuses. The endpoint starts listening right after the lock is created; until then other
// processes see a missing endpoint for a live PID, which is never treated as dead.
export function acquireDirectoryLockSync(directory) {
  const file = path.join(directory, LOCK_NAME), token = randomUUID();
  if (!create(file, lockContent(directory, token))) {
    const owner = readOwner(file);
    throw lockedError(owner, file, owner && !wellFormed(owner) ? (owner.unreadable ? 'the lock file is unreadable or incomplete' : 'the lock file was written by an older version of Cargo or is damaged') : undefined);
  }
  return handle(directory, file, token, endpointFor(directory, token), null);
}

function handle(directory, file, token, endpoint, server) {
  let lost = null, released = false, ino = server ? inode(endpoint) : null;
  const ready = server ? Promise.resolve(true)
    : listen(endpoint).then(s => { server = s; ino = inode(endpoint); if (released) closeEndpoint(); return true; }, () => false);
  function closeEndpoint() {
    if (!server) return;
    if (!windows && ino !== null && inode(endpoint) === ino) fs.rmSync(endpoint, { force: true });
    server.close(); server = null;
  }
  return {
    file, token, endpoint, ready,
    // Fencing check before every read and write of saved state: the lock must still carry our token and our
    // endpoint must still be the one other processes probe. Once lost, ownership is never regained.
    assertHeld() {
      if (lost) throw lost;
      if (released) throw (lost = new OwnershipLostError('This process released the save folder.'));
      const owner = readOwner(file);
      if (owner?.token !== token) lost = new OwnershipLostError('This process no longer owns the save folder (its lock was replaced or removed), so it stopped using it.');
      else if (ino !== null && inode(endpoint) !== ino) lost = new OwnershipLostError('This process can no longer prove it owns the save folder (its liveness endpoint was removed), so it stopped using it.');
      if (lost) throw lost;
    },
    // Remove the lock only if it is still ours; never delete another process's lock.
    release() {
      if (released) return; released = true;
      try { removeIfOwned(file, token); } finally { closeEndpoint(); }
    }
  };
}
