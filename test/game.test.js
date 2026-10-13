import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODES, RULES, CONTAINERS, splitStake, payout, multiplier, survivalOdds, lossChance } from '../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, resetWallet, snapshot } from '../server/game.js';
import { hazardDeck, calibratedRoute, uniformBelow, seedHash } from '../server/fairness.js';
import { verifyRound } from '../public/fairness.js';

const seed='0123456789abcdef'.repeat(4),fresh='fedcba9876543210'.repeat(4);
function start(mode='easy',amount=3000,serverSeed=seed){const s=createSession('test',serverSeed);const r=beginRound(s,{difficulty:mode,stakeCents:amount,clientSeed:'cargo-test',expectedSeedHash:seedHash(serverSeed)},fresh);return [s,r];}
function choose(n,k){let x=1;for(let i=1;i<=k;i++)x=x*(n-k+i)/i;return Math.round(x);}
test('the literal ladder is unchanged: every multiplier matches the original rounded 98%-model ladder',()=>{
 const counts=[19,17,15,10],first=[103,115,131,196],last=[1960,111720,1519392,18106088];
 Object.values(MODES).forEach((m,index)=>{
  assert.equal(m.payouts.length,counts[index]);assert.equal(m.payouts[0],first[index]);assert.equal(m.payouts.at(-1),last[index]);
  m.payouts.forEach((v,i)=>{const survival=choose(19-i,m.hazards)/choose(20,m.hazards);assert.equal(v,Math.round(98/survival));if(i)assert(v>m.payouts[i-1]);});
 });
 // Legacy cargo-v1 odds are stake-independent: h/(21-s) loss at stop s.
 assert.deepEqual(survivalOdds('cargo-v1','easy',1234,1),[19,20]);assert.equal(lossChance('cargo-v1','easy',1234,18),.5);assert.equal(lossChance('cargo-v1','easy',1234,19),0);
 assert.equal(RULES.algorithm,'cargo-v2');assert.equal(RULES.paytable,'ladder-v1');
});
test('cent splits conserve the full bet and payouts round half up',()=>{for(let n=300;n<400;n++){const parts=splitStake(n);assert.equal(parts.reduce((a,b)=>a+b),n);assert(Math.max(...parts)-Math.min(...parts)<=1);}assert.equal(payout(101,150),152);assert.equal(payout(100,131),131);});
test('bet deducts once, consumes the committed seed and hides future hazards',()=>{
 const [s,r]=start();assert.equal(s.balanceCents,97000);assert.equal(s.nonce,1);assert.equal(r.serverSeedHash,seedHash(seed));assert.equal(s.nextSeed,fresh);
 const exposed=snapshot(s);assert.equal(exposed.round.proof.serverSeed,undefined);assert.equal(exposed.round.proof.hazards,undefined);assert.equal(JSON.stringify(exposed).includes(seed),false);assert.equal(s.ledger.length,1);
});
test('invalid amounts, modes, seeds and concurrent rounds cannot debit a bet',()=>{
 for(const stakeCents of [0,-1,299,300001,300.5,NaN,Infinity,'3000']){const s=createSession('bad',seed);assert.throws(()=>beginRound(s,{difficulty:'easy',stakeCents,clientSeed:'x',expectedSeedHash:seedHash(seed)}));assert.equal(s.balanceCents,RULES.startingBalanceCents);}
 const s=createSession('bad',seed),valid={difficulty:'easy',stakeCents:3000,clientSeed:'x',expectedSeedHash:seedHash(seed)};
 for(const change of [{difficulty:'toString'},{expectedSeedHash:'bad'},{clientSeed:''},{clientSeed:'a'.repeat(129)},{stakeCents:100001}]){assert.throws(()=>beginRound(s,{...valid,...change}));assert.equal(s.balanceCents,100000);}
 beginRound(s,valid,fresh);assert.throws(()=>beginRound(s,valid));assert.equal(s.balanceCents,97000);
});
test('cannot collect before stop one, refill while active, or mutate a foreign round',()=>{const [s,r]=start();assert.throws(()=>collectRound(s,r.id,'A'));assert.throws(()=>resetWallet(s));assert.throws(()=>advanceRound(s,'other'));assert.throws(()=>collectRound(s,r.id,'X'));assert.equal(s.balanceCents,97000);});
test('secured cargo stays paid when other cargo is lost; repeated collection is rejected',()=>{
 const [s,r]=start();r.hazards={A:[20],B:[2],C:[3]};advanceRound(s,r.id);collectRound(s,r.id,'A');assert.equal(s.balanceCents,98030);advanceRound(s,r.id);advanceRound(s,r.id);assert.equal(r.status,'settled');assert.equal(r.containers[0].payoutCents,1030);assert.equal(s.balanceCents,98030);
 assert.throws(()=>collectRound(s,r.id,'A'));assert.throws(()=>advanceRound(s,r.id));assert.equal(s.ledger.length,2);assert.equal(s.ledger.map(x=>x.amountCents).reduce((a,b)=>a+b)+100000,s.balanceCents);
});
test('final stop prevents extra risk and collecting all reconciles exact large payouts',()=>{
 const [s,r]=start('expert',3001);r.hazards={A:[11,12,13,14,15,16,17,18,19,20],B:[1,2,3,4,5,6,7,8,9,10],C:[11,12,13,14,15,16,17,18,19,20]};
 for(let i=0;i<10;i++)advanceRound(s,r.id);assert.throws(()=>advanceRound(s,r.id));collectRound(s,r.id,'all');
 const expected=payout(1001,18106088)+payout(1000,18106088);assert.equal(r.status,'settled');assert.equal(s.balanceCents,100000-3001+expected);assert.equal(new Set(s.ledger.map(x=>x.id)).size,s.ledger.length);
});
test('all-lost outcome settles automatically without a payout',()=>{const [s,r]=start();r.hazards={A:[1],B:[1],C:[1]};advanceRound(s,r.id);assert.equal(r.status,'settled');assert.equal(s.balanceCents,97000);assert.equal(snapshot(s).history[0].returnedCents,0);});
test('independent browser verifier reproduces a complete round and rejects tampering',async()=>{
 const [s,r]=start('medium',3001);for(let i=0;i<17&&r.status==='active';i++){advanceRound(s,r.id);if(r.status==='active'&&(i===3||i===16))collectRound(s,r.id,'all');}
 const p=snapshot(s).round;assert.equal((await verifyRound(p)).valid,true);const changed=structuredClone(p);changed.returnedCents++;assert.equal((await verifyRound(changed)).valid,false);
 const wrongSeed=structuredClone(p);wrongSeed.proof.serverSeed=fresh;assert.equal((await verifyRound(wrongSeed)).valid,false);
 const wrongEvent=structuredClone(p);wrongEvent.events[1].lost=['A','B','C'];wrongEvent.events[1].survived=[];assert.equal((await verifyRound(wrongEvent)).valid,false);
 for(const [field,value] of [['algorithm','cargo-v1'],['algorithm','cargo-v9'],['paytable','ladder-v9']]){const relabeled=structuredClone(p);relabeled.proof[field]=value;assert.equal((await verifyRound(relabeled)).valid,false,field+'='+value);}
 const wrongRoute=structuredClone(p);wrongRoute.proof.hazards.A=wrongRoute.proof.hazards.A.length?[]:[17];assert.equal((await verifyRound(wrongRoute)).valid,false);
});
test('hazard decks are repeatable, unique, bounded and vary with seed, nonce and container',()=>{
 const a=hazardDeck(seed,'cargo-test',0,'A',10);assert.equal(a.length,10);assert.equal(new Set(a).size,10);assert(a.every(n=>n>=1&&n<=20));assert.deepEqual(a,hazardDeck(seed,'cargo-test',0,'A',10));
 assert.notDeepEqual(a,hazardDeck(seed,'cargo-test',0,'B',10));assert.notDeepEqual(a,hazardDeck(seed,'cargo-test',1,'A',10));assert.notDeepEqual(a,hazardDeck(fresh,'cargo-test',0,'A',10));
});
test('cargo-v2 odds are valid probabilities and survival × payout is exactly 96.8% of the stake at every stop',()=>{
 // Sampled here; build/check-rtp.mjs checks every container stake from 100 to 100,000 cents.
 const stakes=[...Array.from({length:901},(_,i)=>100+i),1001,3333,33333,99999,100000];
 for(const mode of Object.keys(MODES))for(const w of stakes){
  let num=1n,den=1n;
  MODES[mode].payouts.forEach((m,i)=>{
   const [survive,outOf]=survivalOdds('cargo-v2',mode,w,i+1);assert(0<survive&&survive<outOf&&Number.isSafeInteger(outOf));
   num*=BigInt(survive);den*=BigInt(outOf);
   // P(survive to stop s) × G_s(w) = 968/1000 × w, compared exactly as integers.
   assert.equal(num*BigInt(payout(w,m))*1000n,den*968n*BigInt(w),mode+' w='+w+' stop '+(i+1));
  });
 }
});
test('unbiased sampler rejects the incomplete 64-bit interval and is exact on the accepted range',()=>{
 const TWO_64=1n<<64n,draws=values=>attempt=>values[attempt];
 assert.equal(uniformBelow(3,draws([TWO_64-1n,5n])),2n); // 2^64 mod 3 = 1, so 2^64-1 is rejected
 assert.equal(uniformBelow(3,draws([TWO_64-2n])),(TWO_64-2n)%3n);
 const big=18106088000n,limit=TWO_64-TWO_64%big;assert.equal(uniformBelow(big,draws([limit,limit-1n])),(limit-1n)%big);
 assert.equal(uniformBelow(1,draws([123n])),0n);
});
test('cargo-v2 routes are deterministic, pinned to the round and vary with seed, nonce, container and stake',()=>{
 const route=(...a)=>calibratedRoute(seed,'cargo-test',...a);
 const [s,r]=start('hard',3001);assert.equal(r.algorithm,'cargo-v2');assert.equal(r.paytable,'ladder-v1');
 CONTAINERS.forEach((c,i)=>assert.deepEqual(r.hazards[c],calibratedRoute(seed,'cargo-test',0,c,'hard',r.containers[i].stakeCents,'ladder-v1')));
 const routes=new Set();for(let nonce=0;nonce<200;nonce++)for(const c of CONTAINERS){const x=route(nonce,c,'expert',1000,'ladder-v1');assert(x.length<=1&&x.every(n=>n>=1&&n<=10));routes.add(c+nonce+':'+x);}
 const firstLoss=[...routes].filter(x=>x.endsWith(':1')).length/routes.size;assert(firstLoss>.4&&firstLoss<.62,'expert stop-1 loss rate '+firstLoss);
 assert.deepEqual(route(7,'A','easy',1000,'ladder-v1'),route(7,'A','easy',1000,'ladder-v1'));
});
test('each onboard container shows its own exact risk; a shared risk appears only when the odds are identical',()=>{
 const [s,r]=start('easy',3001),view=snapshot(s).round;assert.equal(view.nextRisk,null);
 assert.deepEqual(view.containers.map(c=>c.nextSurvival),[[121*1001,125*1031],[121*1000,125*1030],[121*1000,125*1030]]);
 assert.equal(view.containers[0].nextRisk,(125*1031-121*1001)/(125*1031));assert.notEqual(view.containers[0].nextRisk,view.containers[1].nextRisk);
 const [even]=start('easy',3000),shared=snapshot(even).round;assert.equal(shared.nextRisk,(128750-121000)/128750);assert(shared.containers.every(c=>c.nextRisk===shared.nextRisk));
 r.hazards={A:[],B:[],C:[]};advanceRound(s,r.id);collectRound(s,r.id,'A');const after=snapshot(s).round;
 assert.equal(after.containers[0].nextRisk,null);assert.deepEqual(after.containers[1].nextSurvival,[payout(1000,103),payout(1000,109)]);assert.equal(after.nextRisk,after.containers[1].nextRisk);
});
test('a cargo-v1 round accepted before the upgrade keeps its deck, odds and payouts and still verifies',async()=>{
 const [s,r]=start('medium',3001);r.algorithm='cargo-v1';delete r.paytable;
 for(const c of CONTAINERS)r.hazards[c]=hazardDeck(seed,'cargo-test',0,c,MODES.medium.hazards);
 assert.equal(snapshot(s).round.nextRisk,3/20);assert.equal(snapshot(s).round.proof.paytable,'ladder-v1');
 for(let i=0;i<17&&r.status==='active';i++){advanceRound(s,r.id);if(r.status==='active'&&(i===2||i===16))collectRound(s,r.id,'all');}
 const p=snapshot(s).round;assert.equal(p.proof.algorithm,'cargo-v1');assert.equal((await verifyRound(p)).valid,true);
 for(const c of p.containers.filter(c=>c.status==='collected'))assert.equal(c.payoutCents,payout(c.stakeCents,multiplier('medium',c.collectedAt)));
});
test('historical proofs exported by the original engine remain valid and tamper-evident',async()=>{
 const proofs=JSON.parse(fs.readFileSync(new URL('./fixtures/cargo-v1-proofs.json',import.meta.url),'utf8'));
 assert.deepEqual(proofs.map(p=>p.difficulty),['easy','medium','hard','expert']);
 for(const p of proofs){assert.equal(p.proof.algorithm,'cargo-v1');assert.equal('paytable' in p.proof,false);assert.equal((await verifyRound(p)).valid,true,p.difficulty);
  const relabeled=structuredClone(p);relabeled.proof.algorithm='cargo-v2';assert.equal((await verifyRound(relabeled)).valid,false);}
});
