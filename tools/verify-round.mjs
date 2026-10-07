import fs from 'node:fs';
import { verifyRound } from '../public/fairness.js';
const file=process.argv[2];
if(!file){console.error('Usage: node tools/verify-round.mjs path/to/exported-round.json');process.exitCode=1;}
else try{const round=JSON.parse(fs.readFileSync(file,'utf8'));const result=await verifyRound(round);console.log((result.valid?'VERIFIED: ':'FAILED: ')+result.message);process.exitCode=result.valid?0:1;}
catch(error){console.error('Could not read the proof: '+error.message);process.exitCode=1;}
