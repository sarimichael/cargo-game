import { CONTAINERS, MODES, RULES, randomMessage, splitStake, payout, multiplier, nextRisk } from './math.js';

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
const decode = value => Uint8Array.from(value.match(/.{2}/g), s => parseInt(s,16));
// Strict cargo-v1 proof schema: unknown fields are refused so that nothing unverified can be displayed as verified.
const ROUND_KEYS = ['id','difficulty','stakeCents','step','status','startedAt','finishedAt','multiplier100','nextRisk','maxStops','returnedCents','netCents','containers','proof','events'];
const PROOF_KEYS = ['algorithm','serverSeedHash','clientSeed','nonce','serverSeed','hazards'];
const CONTAINER_KEYS = ['id','stakeCents','status','payoutCents','collectedAt','lostAt','valueCents'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const isTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
function checkStructure(round) {
  if (!sameKeys(round, ROUND_KEYS) || !sameKeys(round.proof, PROOF_KEYS)) throw new Error('The proof does not match the cargo-v1 format.');
  if (round.proof.algorithm !== 'cargo-v1') throw new Error('Unsupported proof algorithm.');
  if (typeof round.id !== 'string' || !UUID.test(round.id)) throw new Error('The round ID is malformed.');
  if (!Object.hasOwn(MODES, round.difficulty)) throw new Error('Unknown difficulty.');
  if (!Number.isSafeInteger(round.stakeCents) || round.stakeCents < RULES.minBetCents || round.stakeCents > RULES.maxBetCents) throw new Error('The bet amount is invalid.');
  const { clientSeed, nonce, serverSeedHash, hazards } = round.proof;
  if (typeof clientSeed !== 'string' || clientSeed.length < 1 || clientSeed.length > 128) throw new Error('The client seed is invalid.');
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('The nonce is invalid.');
  if (typeof serverSeedHash !== 'string' || !/^[a-f0-9]{64}$/.test(serverSeedHash)) throw new Error('The seed commitment is malformed.');
  if (!sameKeys(hazards, CONTAINERS)) throw new Error('The proof must contain exactly the A, B and C hazard decks.');
  if (!Array.isArray(round.containers) || round.containers.length !== CONTAINERS.length || round.containers.some((c, i) => !sameKeys(c, CONTAINER_KEYS) || c.id !== CONTAINERS[i])) throw new Error('The round must list containers A, B and C exactly once each.');
  if (!Array.isArray(round.events)) throw new Error('The event list is malformed.');
  if (!isTime(round.startedAt) || !isTime(round.finishedAt) || Date.parse(round.finishedAt) < Date.parse(round.startedAt)) throw new Error('The round timestamps are malformed.');
}
export async function verifyRound(round) {
  try {
    if (!round || typeof round !== 'object' || round.status !== 'settled' || !/^[a-f0-9]{64}$/.test(round.proof?.serverSeed || '')) return { valid:false, message:'The server seed is revealed after every container is collected or lost.' };
    checkStructure(round);
    const seed = decode(round.proof.serverSeed);
    const hash = hex(await crypto.subtle.digest('SHA-256',seed));
    if (hash !== round.proof.serverSeedHash) throw new Error('Server seed does not match its commitment.');
    const key = await crypto.subtle.importKey('raw',seed,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const decks = {};
    for (const id of CONTAINERS) {
      let counter = 0;
      async function int(bound) {
        const limit = Math.floor(0x100000000 / bound) * bound;
        for (;;) {
          const signature = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(randomMessage(round.proof.clientSeed,round.proof.nonce,id,counter++)));
          const value = new DataView(signature).getUint32(0,false);
          if (value < limit) return value % bound;
        }
      }
      const deck = Array.from({length:20},(_,i)=>i+1);
      for (let i=19;i>0;i--) { const j=await int(i+1); [deck[i],deck[j]]=[deck[j],deck[i]]; }
      decks[id]=deck.slice(0,MODES[round.difficulty].hazards).sort((a,b)=>a-b);
      if (JSON.stringify(decks[id])!==JSON.stringify(round.proof.hazards[id])) throw new Error('The hazard deck differs from the committed seed.');
    }
    const stakes=splitStake(round.stakeCents), cargo=CONTAINERS.map((id,i)=>({id,stakeCents:stakes[i],status:'onboard',payoutCents:0,collectedAt:null,lostAt:null}));
    let step=0,total=0;
    if (round.events[0]?.kind!=='bet'||round.events[0].stakeCents!==round.stakeCents) throw new Error('Bet event is inconsistent.');
    for (const event of round.events.slice(1)) {
      if (cargo.every(c=>c.status!=='onboard')) throw new Error('Events continue after settlement.');
      if (event.kind==='sail') {
        if (event.step!==step+1||event.step>MODES[round.difficulty].payouts.length) throw new Error('Sail events are out of order.');
        step++;const lost=[],survived=[];
        for (const c of cargo) if (c.status==='onboard') {
          if (decks[c.id].includes(step)) {c.status='lost';c.lostAt=step;lost.push(c.id);} else survived.push(c.id);
        }
        if (JSON.stringify(lost)!==JSON.stringify(event.lost)||JSON.stringify(survived)!==JSON.stringify(event.survived)) throw new Error('Sail outcome does not match the seed.');
      } else if (event.kind==='collect') {
        if (event.step!==step||step<1||!Object.keys(event.credits).length) throw new Error('Collection event is inconsistent.');
        for (const [id,amount] of Object.entries(event.credits)) {
          const c=cargo.find(c=>c.id===id);
          if (!c||c.status!=='onboard'||amount!==payout(c.stakeCents,multiplier(round.difficulty,step))) throw new Error('A payout is inconsistent.');
          c.status='collected';c.payoutCents=amount;c.collectedAt=step;total+=amount;
        }
      } else throw new Error('Unknown event.');
    }
    if (step!==round.step||cargo.some(c=>c.status==='onboard')||total!==round.returnedCents||total-round.stakeCents!==round.netCents) throw new Error('The settled totals do not reconcile.');
    for (const c of cargo) {
      const reported=round.containers.find(x=>x.id===c.id);
      if (!reported||Object.keys(c).some(k=>reported[k]!==c[k])||reported.valueCents!==c.payoutCents) throw new Error('A final container state is inconsistent.');
    }
    if (round.multiplier100!==multiplier(round.difficulty,step)||round.maxStops!==MODES[round.difficulty].payouts.length||round.nextRisk!==nextRisk(round.difficulty,step)) throw new Error('The displayed multiplier, risk or stop count is inconsistent.');
    return {valid:true,message:'Seed commitment, all three hazard decks, every stop, and all payouts verified.',decks};
  } catch(error) { return {valid:false,message:error.message}; }
}
