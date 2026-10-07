import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createApp } from './app.js';
import { execFile } from 'node:child_process';

if(Number(process.versions.node.split('.')[0])<22)throw new Error('Cargo needs Node.js 22 or newer. Install the current LTS version.');
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const directory = process.env.CARGO_DATA_DIR || fileURLToPath(new URL('../data/',import.meta.url));
const app = createApp(new Store(directory));
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
