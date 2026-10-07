import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, RULES, splitStake, payout, nextRisk } from '../public/math.js';
import { createSession, beginRound, advanceRound, collectRound, resetWallet, snapshot } from '../server/game.js';
import { hazardDeck, seedHash } from '../server/fairness.js';
import { verifyRound } from '../public/fairness.js';

const seed='0123456789abcdef'.repeat(4),fresh='fedcba9876543210'.repeat(4);
function start(mode='easy',amount=3000,serverSeed=seed){const s=createSession('test',serverSeed);const r=beginRound(s,{difficulty:mode,stakeCents:amount,clientSeed:'cargo-test',expectedSeedHash:seedHash(serverSeed)},fresh);return [s,r];}
function choose(n,k){let x=1;for(let i=1;i<=k;i++)x=x*(n-k+i)/i;return Math.round(x);}
test('every payout matches the requested rounded 98%-model ladder and increasing risk',()=>{
 const counts=[19,17,15,10],first=[103,115,131,196],last=[1960,111720,1519392,18106088];
 Object.values(MODES).forEach((m,index)=>{
  assert.equal(m.payouts.length,counts[index]);assert.equal(m.payouts[0],first[index]);assert.equal(m.payouts.at(-1),last[index]);
  m.payouts.forEach((v,i)=>{const survival=choose(19-i,m.hazards)/choose(20,m.hazards);assert.equal(v,Math.round(98/survival));if(i)assert(v>m.payouts[i-1]);});
 });
 assert.equal(nextRisk('easy',0),.05);assert.equal(nextRisk('easy',18),.5);assert.equal(nextRisk('easy',19),0);
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
});
test('hazard decks are repeatable, unique, bounded and vary with seed, nonce and container',()=>{
 const a=hazardDeck(seed,'cargo-test',0,'A',10);assert.equal(a.length,10);assert.equal(new Set(a).size,10);assert(a.every(n=>n>=1&&n<=20));assert.deepEqual(a,hazardDeck(seed,'cargo-test',0,'A',10));
 assert.notDeepEqual(a,hazardDeck(seed,'cargo-test',0,'B',10));assert.notDeepEqual(a,hazardDeck(seed,'cargo-test',1,'A',10));assert.notDeepEqual(a,hazardDeck(fresh,'cargo-test',0,'A',10));
});
