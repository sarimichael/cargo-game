import fs from 'node:fs/promises';
import { build } from 'esbuild';
await fs.mkdir('dist/server',{recursive:true});
await fs.mkdir('dist/.openai',{recursive:true});
await fs.cp('public','dist/client',{recursive:true});
await fs.copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await build({entryPoints:['server/worker.js'],bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['node:*'],outfile:'dist/server/index.js',banner:{js:"import { Buffer } from 'node:buffer';"}});
await fs.writeFile('dist/server/wrangler.json',JSON.stringify({name:'cargo-mobile',main:'index.js',compatibility_date:'2025-11-01',compatibility_flags:['nodejs_compat'],assets:{directory:'../client',binding:'ASSETS',run_worker_first:['/api/*']}},null,2));
console.log('Built Cargo mobile game and server.');
