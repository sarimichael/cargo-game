import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApp } from './app.js';
import { execFile } from 'node:child_process';

if(Number(process.versions.node.split('.')[0])<22)throw new Error('Cargo needs Node.js 22 or newer. Install the current LTS version.');
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const directory = process.env.CARGO_DATA_DIR || fileURLToPath(new URL('../data/',import.meta.url));
const store = new Store(directory);
try { await store.acquire(); }
catch (error) { if (!['DATA_DIRECTORY_LOCKED', 'DATA_DIRECTORY_UNAVAILABLE'].includes(error.code)) throw error; console.error('\n' + error.message + '\n'); process.exit(1); }
// Release the save-folder lock on every orderly exit. After a crash the next start confirms the old process has
// gone (see server/lock.js) and recovers the folder; if it cannot confirm that, it refuses and explains why.
process.on('exit', () => store.release());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
const app = createApp(store);
// If this process ever loses the folder, stop: requests already get 503 and nothing more is read or written.
store.onLost = error => {
  console.error('\n' + error.message + ' Cargo is stopping; restart it once the other server has closed.\n');
  process.exitCode = 1; app.close(); setTimeout(() => process.exit(1), 250).unref();
};
store.watch(1000);
app.on('error',error => { console.error(error.code === 'EADDRINUSE' ? 'Cargo is already running, or this port is in use. Try http://127.0.0.1:'+port : error.message); process.exitCode = 1; });
app.listen(port,'127.0.0.1',() => {
  const address='http://127.0.0.1:'+port;
  console.log('\nCargo is ready. Open '+address+'\nPlay-money prototype · press Ctrl+C to stop.\n');
  if (process.argv.includes('--open')) {
    const command=process.platform==='win32'?'cmd.exe':process.platform==='darwin'?'open':'xdg-open';
    const args=process.platform==='win32'?['/d','/c','start','',address]:[address];
    execFile(command,args,{windowsHide:true},error=>{if(error)console.log('Open '+address+' in your browser.');});
  }
});
