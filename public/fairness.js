import { CONTAINERS, MODES, PAYTABLES, LEGACY_PAYTABLE, RTP_NUMERATOR, RTP_DENOMINATOR, randomMessage, routeMessage, splitStake, payout, multiplier } from './math.js';

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
const decode = value => Uint8Array.from(value.match(/.{2}/g), s => parseInt(s,16));
export async function verifyRound(round) {
  try {
    if (round.status !== 'settled' || !/^[a-f0-9]{64}$/.test(round.proof.serverSeed || '')) return { valid:false, message:'The server seed is revealed after every container is collected or lost.' };
    // Proofs from before rules were pinned have no payout table ID and use the original ladder.
    const algorithm = round.proof.algorithm, paytable = round.proof.paytable ?? LEGACY_PAYTABLE;
    if (algorithm !== 'cargo-v1' && algorithm !== 'cargo-v2') throw new Error('The randomness algorithm is not recognized.');
    if (!Object.hasOwn(PAYTABLES, paytable) || !Object.hasOwn(MODES, round.difficulty)) throw new Error('The payout table is not recognized.');
    const seed = decode(round.proof.serverSeed);
    const hash = hex(await crypto.subtle.digest('SHA-256',seed));
    if (hash !== round.proof.serverSeedHash) throw new Error('Server seed does not match its commitment.');
    const key = await crypto.subtle.importKey('raw',seed,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const stakes=splitStake(round.stakeCents), decks = {};
    if (algorithm === 'cargo-v2') {
      const ladder = PAYTABLES[paytable][round.difficulty], TWO_64 = 1n << 64n;
      for (const [index,id] of CONTAINERS.entries()) {
        const w = stakes[index], G = s => BigInt(payout(w, ladder[s-1]));
        decks[id] = [];
        for (let step=1; step<=ladder.length; step++) {
          // Survival odds recomputed here from the published formula, independent of the server's helper.
          const survive = step===1 ? BigInt(RTP_NUMERATOR*w) : G(step-1), outOf = step===1 ? BigInt(RTP_DENOMINATOR)*G(1) : G(step);
          const limit = TWO_64 - TWO_64 % outOf;
          let value;
          for (let attempt=0; ; attempt++) {
            const signature = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(routeMessage(round.proof.clientSeed,round.proof.nonce,id,step,attempt)));
            value = new DataView(signature).getBigUint64(0,false);
            if (value < limit) break;
          }
          if (value % outOf >= survive) { decks[id].push(step); break; }
        }
        if (JSON.stringify(decks[id])!==JSON.stringify(round.proof.hazards[id])) throw new Error('The cargo route differs from the committed seed.');
      }
    } else for (const id of CONTAINERS) {
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
    const cargo=CONTAINERS.map((id,i)=>({id,stakeCents:stakes[i],status:'onboard',payoutCents:0,collectedAt:null,lostAt:null}));
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
          if (!c||c.status!=='onboard'||amount!==payout(c.stakeCents,multiplier(round.difficulty,step,paytable))) throw new Error('A payout is inconsistent.');
          c.status='collected';c.payoutCents=amount;c.collectedAt=step;total+=amount;
        }
      } else throw new Error('Unknown event.');
    }
    if (step!==round.step||cargo.some(c=>c.status==='onboard')||total!==round.returnedCents||total-round.stakeCents!==round.netCents) throw new Error('The settled totals do not reconcile.');
    for (const c of cargo) {
      const reported=round.containers.find(x=>x.id===c.id);
      if (!reported||Object.keys(c).some(k=>reported[k]!==c[k])) throw new Error('A final container state is inconsistent.');
    }
    return {valid:true,message:`Seed commitment, all three ${algorithm==='cargo-v2'?'cargo routes':'hazard decks'}, every stop, and all payouts verified.`,decks};
  } catch(error) { return {valid:false,message:error.message}; }
}
