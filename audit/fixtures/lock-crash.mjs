// Test fixture (phase 4A.1): take the save-folder lock, report READY, then wait to be killed.
// Killing it with SIGKILL leaves a genuine stale lock in whatever format the code under test writes.
// Usage: node lock-crash.mjs <repo> <dir>
const [, , repo, dir] = process.argv;
const { acquireDirectoryLock } = await import(repo + '/server/lock.js');
const handle = await acquireDirectoryLock(dir);
await handle.ready?.catch?.(() => {});
console.log('READY');
setInterval(() => {}, 1000);
