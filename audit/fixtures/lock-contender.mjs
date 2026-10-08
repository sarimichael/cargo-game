// Test fixture (phase 4A.1): one contender for the save-folder lock.
// Usage: node lock-contender.mjs <repo> <dir> <startAtEpochMs> <releaseSignalFile>
// Waits for a shared start instant, tries to take the lock, and — if it becomes the owner —
// keeps verifying ownership until the release-signal file appears. No fixed holding period.
// Prints exactly one line: REFUSED, ERROR <msg>, or OWNER:HELD / OWNER:LOST.
import fs from 'node:fs';
const [, , repo, dir, startAt, signal] = process.argv;
const { acquireDirectoryLock } = await import(repo + '/server/lock.js');
while (Date.now() < Number(startAt)) { /* spin so that all contenders start together */ }
let handle;
try { handle = await acquireDirectoryLock(dir); }
catch (error) { console.log(error.code === 'DATA_DIRECTORY_LOCKED' ? 'REFUSED' : 'ERROR ' + (error.code || '') + ' ' + error.message); process.exit(0); }
await handle.ready?.catch?.(() => {});
fs.writeFileSync(`${signal}.owner.${process.pid}`, ''); // tell the test an owner exists
let lost = false;
const timer = setInterval(() => {
  try { handle.assertHeld(); } catch { lost = true; }
  if (fs.existsSync(signal)) { clearInterval(timer); console.log(lost ? 'OWNER:LOST' : 'OWNER:HELD'); handle.release(); process.exit(0); }
}, 5);
