import { MODES, RULES, CONTAINERS, splitStake, payout, multiplier, payoutsFor, nextRisk, formatMoney as money, formatMultiplier as mult } from './math.js';
import { OceanScene } from './scene.js';
import { collisionFor, isShipwreck } from './collision.js';
import { verifyRound } from './fairness.js';

const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PORTS=['Breakwater','Buoy One','Sheltered Cove','Sandbar','Beacon Port','Outer Reef','Blue Channel','Open Strait','Headland','Deep Bay','Crosswind','Reef Passage','High Seas','Storm Line','Darkwater','Maelstrom','Narrow Reach','Last Beacon','Final Port'];
const colors=['#5ce6bb','#edc175','#a99be9'];
let data=null,selectedMode='easy',busy=false,connected=true,hiddenRoundId=null,clientSeed='',toastTimer,eventTimer,modalRound=null;
const scene=new OceanScene($('ocean'));
let soundEnabled=localStorage.getItem('cargo-sound')==='on',audio=null;
function sound(type){
 if(!soundEnabled)return;try{audio ||= new AudioContext();audio.resume();
 if(type==='iceberg'||type==='debris'){
  const hard=type==='iceberg',at=audio.currentTime,length=hard?.85:.35,o=audio.createOscillator(),g=audio.createGain();o.type='triangle';o.frequency.setValueAtTime(hard?94:160,at);o.frequency.exponentialRampToValueAtTime(hard?34:65,at+length);g.gain.setValueAtTime(.0001,at);g.gain.linearRampToValueAtTime(hard?.11:.07,at+.018);g.gain.exponentialRampToValueAtTime(.0001,at+length);o.connect(g);g.connect(audio.destination);o.start(at);o.stop(at+length);
  const buffer=audio.createBuffer(1,Math.ceil(audio.sampleRate*length),audio.sampleRate),samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=(Math.random()*2-1)*(1-i/samples.length);const noise=audio.createBufferSource(),filter=audio.createBiquadFilter(),volume=audio.createGain();noise.buffer=buffer;filter.type='lowpass';filter.frequency.value=hard?900:420;volume.gain.setValueAtTime(hard?.08:.035,at);volume.gain.exponentialRampToValueAtTime(.0001,at+length);noise.connect(filter);filter.connect(volume);volume.connect(audio.destination);noise.start(at);return;
 }
 let frequencies=type==='collect'?[523.25,659.25,783.99]:type==='loss'?[110,82.4]:type==='arrive'?[392,523.25]:[720];
 frequencies.forEach((f,i)=>{const o=audio.createOscillator(),g=audio.createGain(),at=audio.currentTime+i*.08;o.frequency.value=f;o.type=type==='loss'?'triangle':'sine';g.gain.setValueAtTime(0,at);g.gain.linearRampToValueAtTime(.055,at+.015);g.gain.exponentialRampToValueAtTime(.0001,at+.3);o.connect(g);g.connect(audio.destination);o.start(at);o.stop(at+.32)});
 }catch{soundEnabled=false;}
}
function soundButton(){$('sound-button').textContent=soundEnabled?'♫':'♪';$('sound-button').setAttribute('aria-pressed',String(soundEnabled));$('sound-button').setAttribute('aria-label',soundEnabled?'Turn sound off':'Turn sound on');}
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?6500:3800);}
function showEvent(message,loss=false){clearTimeout(eventTimer);$('scene-event').textContent=message;$('scene-event').classList.toggle('loss',loss);$('scene-event').hidden=false;eventTimer=setTimeout(()=>$('scene-event').hidden=true,2200);}
function parseStake(){const text=$('bet-amount').value.trim();if(!/^\d{1,7}(?:\.\d{0,2})?$/.test(text))return null;const [d,c='']=text.split('.');const n=Number(d)*100+Number(c.padEnd(2,'0'));return Number.isSafeInteger(n)?n:null;}
function visibleRound(){return data?.round&&data.round.id!==hiddenRoundId?data.round:null;}
function riskColor(r){return r<=.075?'#69d9f1':r<=.12?'#5ce6bb':r<=.25?'#edc175':'#f58396';}
function isActive(){return data?.round?.status==='active';}

function render(){
 if(!data)return;document.body.classList.remove('loading');const r=visibleRound(),active=r?.status==='active',wreck=isShipwreck(r),mode=r?.difficulty||selectedMode,info={...MODES[mode],payouts:payoutsFor(mode,r?.proof.paytable)},stake=r?.stakeCents??parseStake()??3000;
 $('scene').classList.toggle('shipwreck',!!wreck);
 $('ocean').setAttribute('aria-label',wreck?'Cargo ship sunk after an iceberg collision':'Animated cargo ship sailing between ports');
 const valid=Number.isSafeInteger(stake)&&stake>=RULES.minBetCents&&stake<=RULES.maxBetCents&&stake<=data.session.balanceCents;
 $('balance').textContent=money(data.session.balanceCents);$('save-status').textContent=connected?'Your voyage is saved':'Connection lost · refresh to reconnect';$('connection').style.background=connected?'var(--mint)':'var(--red)';
 if(r)$('bet-amount').value=(r.stakeCents/100).toFixed(2);
 $('bet-amount').disabled=active||busy;$('half-bet').disabled=active||busy;$('double-bet').disabled=active||busy;
 const stakes=splitStake(stake);$('bet-help').textContent=valid||active?stakes.every(x=>x===stakes[0])?'3 containers · '+money(stakes[0])+' each':stakes.map((n,i)=>CONTAINERS[i]+' '+money(n)).join(' · '):stake>data.session.balanceCents?'Not enough play money.':'Bet between $3.00 and $3,000.00.';
 $('bet-help').classList.toggle('invalid',!valid&&!active);
 $('difficulty').innerHTML=Object.entries(MODES).map(([k,m])=>`<button class="difficulty-button" data-mode="${k}" aria-pressed="${mode===k}" ${active||busy?'disabled':''}><span><i></i>${m.name}<b>✓</b></span><small>${m.payouts.length} stops</small></button>`).join('');
 for(const b of $('difficulty').children){b.style.setProperty('--mode-color',MODES[b.dataset.mode].color);b.addEventListener('click',()=>{selectedMode=b.dataset.mode;hiddenRoundId=data.round?.id||null;$('scene-event').hidden=true;sound('click');render();});}
 $('mode-hint').textContent=active?'LOCKED FOR THIS VOYAGE':'CHOOSE YOUR SEAS';
 const risk=nextRisk(mode,r?.step||0),final=r?.step===info.payouts.length;
 $('risk-label').textContent=r&&!active?'VOYAGE RESULT':final?'FINAL PORT':r?'NEXT STOP RISK':'FIRST STOP RISK';$('risk-percent').textContent=r&&!active?'Settled':final?'Reached':(risk*100).toFixed(1)+'%';$('risk-percent').style.color=riskColor(risk);
 $('risk-description').textContent=r&&!active?'All cargo resolved':final?'Collect remaining cargo':'loss chance per cargo';$('risk-fill').style.width=(r&&!active?0:risk*100)+'%';$('risk-fill').style.background=riskColor(risk);
 const returned=r?.returnedCents||0,onboard=r?r.containers.reduce((a,c)=>a+(c.status==='onboard'?c.valueCents:0),0):stake;
 $('secured').textContent=money(returned);$('onboard').textContent=money(onboard);
 const sail=$('sail-button');sail.disabled=busy||!connected||(!r&&!valid);sail.textContent=busy?'Saving action…':!r?'Set sail · '+money(stake):!active?'New voyage':final?'Collect final cargo':'Sail to stop '+String(r.step+1).padStart(2,'0');
 $('collect-all').hidden=!active||r.step<1||final;$('collect-all').disabled=busy||!connected;
 $('action-help').textContent=busy?'Your action is being saved.':!r?'Choose your risk. Collect cargo separately.':!active?'All cargo outcomes are settled.':r.step===0?'Your bet is placed. Sail to the first stop.':final?'All stops completed. Collect surviving cargo.':'Collected cargo stays secured if another is lost.';
 $('refill-button').disabled=active||busy||!connected;
 $('current-multiplier').hidden=!r||!active;$('current-value').textContent=mult(r?.multiplier100||100);$('current-stop').textContent=r?.step?'STOP '+String(r.step).padStart(2,'0'):'DEPARTURE';
 $('stage-badge').textContent=!r?'READY AT THE HARBOR':!active?'VOYAGE COMPLETE':r.step===0?'READY TO DEPART':final?'FINAL PORT REACHED':'STOP '+String(r.step).padStart(2,'0')+' OF '+info.payouts.length;
 $('stage-title').textContent=!r?'Choose the seas you want to sail.':!active?'Your voyage is settled.':r.step===0?'Your cargo is loaded.':final?'Final Port':PORTS[r.step-1];
 $('stage-description').textContent=!r?'Each stop brings more risk and a higher multiplier.':!active?'Your collected payouts are in your balance.':r.step===0?'Sail to the first stop to unlock collection.':final?'Collect the remaining cargo.':'Collect any cargo, or risk the next stop.';
 if(wreck){$('stage-badge').textContent='ICEBERG COLLISION';$('stage-title').textContent='The ship went down.';$('stage-description').textContent='All three containers were lost at sea.';}
 $('next-title').textContent=!r?info.name.toUpperCase()+' ROUTE':final?'FINAL MULTIPLIER':'NEXT STOP '+String(r.step+1).padStart(2,'0');$('stop-count').textContent=info.payouts.length+' stops';
 $('next-value').textContent=mult(!r?info.payouts.at(-1):final?r.multiplier100:info.payouts[r.step]);$('next-value').style.color=!r?info.color:riskColor(risk);
 $('next-caption').textContent=!r?'Final stop multiplier':final?'Collect the surviving cargo':(risk*100).toFixed(1)+'% loss chance per cargo';
 $('next-title').parentElement.parentElement.hidden=!!r&&!active;
 $('scene-caption').textContent=!r?'Every cargo gets its own route. Collect one, keep the others sailing.':!active?'The voyage is complete. Review it in History or verify the round.':r.step===0?'Three containers are loaded. No payouts before the first stop.':final?'Final stop reached at '+mult(r.multiplier100)+'. Collect the remaining value.':'Secure a container now, or keep it sailing to a higher multiplier.';
 $('result-overlay').hidden=!r||active;
 if(r&&!active){$('result-value').textContent=money(r.returnedCents);$('result-label').textContent=wreck?'ALL CARGO LOST · STOP '+r.step:r.step===info.payouts.length?'ALL '+info.payouts.length+' STOPS COMPLETED':'VOYAGE SETTLED · STOP '+r.step;$('result-net').textContent='Net result '+(r.netCents>=0?'+':'−')+money(Math.abs(r.netCents));$('result-net').classList.toggle('negative',r.netCents<0);}
 $('route-label').textContent=info.name.toUpperCase()+' · '+info.payouts.length+' STOPS';$('route-label').style.color=info.color;
 const track=$('route-track');track.style.setProperty('--stops',info.payouts.length);
 track.innerHTML=info.payouts.map((v,i)=>`<div class="stop-tile ${r&&r.step>i?'reached':''} ${r&&r.step===i+1?'current':''}" title="Stop ${i+1}: ${mult(v)} · ${(info.hazards/(20-i)*100).toFixed(1)}% loss chance" ${r&&r.step===i+1?'aria-current="step"':''}><span>${String(i+1).padStart(2,'0')}${r&&r.step>i+1?' ✓':''}</span><strong>${mult(v)}</strong></div>`).join('');
 for(let i=0;i<track.children.length;i++)track.children[i].style.setProperty('--stop-color',riskColor(info.hazards/(20-i)));
 const current=track.querySelector('.current');if(current&&track.scrollWidth>track.clientWidth)track.scrollLeft=Math.max(0,current.offsetLeft-track.offsetLeft-track.clientWidth/2+current.clientWidth/2);
 const cargo=r?.containers||CONTAINERS.map((id,i)=>({id,stakeCents:stakes[i],valueCents:stakes[i],status:'onboard'}));
 $('cargo-grid').innerHTML=cargo.map((c,i)=>{const collected=c.status==='collected',lost=c.status==='lost',enabled=active&&!busy&&connected&&r.step>0&&!collected&&!lost,mm=collected?mult(multiplier(mode,c.collectedAt,r.proof.paytable)):lost?'No payout':mult(r?.multiplier100||100);
 return `<article class="cargo-card ${collected?'collected':lost?'lost':''}" data-cargo="${c.id}"><div class="cargo-header"><div class="cargo-icon" aria-hidden="true"><span></span></div><div><h2>CARGO ${c.id}</h2><p>${collected?'COLLECTED AT STOP '+String(c.collectedAt).padStart(2,'0'):lost?'LOST AT STOP '+String(c.lostAt).padStart(2,'0'):!r?money(c.stakeCents)+' STARTING STAKE':'ON BOARD · STOP '+String(r.step).padStart(2,'0')}</p></div></div><div class="cargo-value"><strong>${money(c.valueCents)}</strong><span>${mm}</span></div><button class="cargo-action" data-collect="${c.id}" ${enabled?'':'disabled'}>${collected?'✓ Secured '+money(c.payoutCents):lost?'Container lost':busy?'Saving action…':!r?money(c.stakeCents)+' allocated':r.step===0?'Ready to sail':'Collect '+money(c.valueCents)}</button></article>`;
 }).join('');
 for(let i=0;i<$('cargo-grid').children.length;i++)$('cargo-grid').children[i].style.setProperty('--cargo-color',colors[i]);
 document.querySelectorAll('[data-collect]').forEach(b=>b.addEventListener('click',()=>collect(b.dataset.collect)));
 $('status-text').textContent=busy?'Action in progress':!r?'Ready to sail':active?'Voyage in progress':'Voyage settled';$('round-label').textContent=r?'ROUND '+r.id.slice(0,8).toUpperCase():'PLAY-MONEY PROTOTYPE';$('export-round').hidden=!r||active;
 if(!scene.motion)scene.setState(r,mode);
}

async function api(path,options={}){
 const response=await fetch(path,{...options,signal:AbortSignal.timeout(7000)}),result=await response.json();
 if(!response.ok){const error=new Error(result.error||'The game could not complete this action.');error.code=result.code;throw error;}return result;
}
async function sync(){data=await api('/api/session');connected=true;if(!clientSeed)clientSeed=localStorage.getItem('cargo-client-seed')||data.session.clientSeed;const r=visibleRound();if(r)selectedMode=r.difficulty;render();}
function offline(){connected=false;document.body.classList.remove('loading');$('save-status').textContent='Connection lost · refresh to reconnect';$('connection').style.background='var(--red)';$('sail-button').disabled=true;$('collect-all').disabled=true;document.querySelectorAll('[data-collect]').forEach(b=>b.disabled=true);}
async function action(path,extra={},animation=null){
 if(busy||!data)return;busy=true;const old=visibleRound(),payload={...extra,actionId:crypto.randomUUID(),revision:data.session.revision};render();
 if(animation==='sail'){$('sail-button').textContent='Sailing…';$('stage-badge').textContent='VOYAGE UNDERWAY';document.querySelectorAll('[data-collect]').forEach(b=>b.textContent='Sailing…');}
 try{
  let result;for(let attempt=0;attempt<2;attempt++){try{result=await api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});break;}catch(e){if(e.code||attempt===1)throw e;}}
  const collision=collisionFor(old,result.round,animation);
  if(animation&&result.round){await scene.transition(old,result.round,animation,kind=>{
   sound(kind);$('stage-badge').textContent=kind==='iceberg'?'ICEBERG COLLISION':'FLOATING DEBRIS';$('stage-title').textContent=kind==='iceberg'?'Brace for impact!':'A glancing hit.';$('stage-description').textContent=kind==='iceberg'?'The ship is taking on water.':'Cargo has slipped overboard.';
   showEvent(kind==='iceberg'?'Iceberg hit · all cargo lost':'Debris hit · Cargo '+collision.lost.join(' + ')+' overboard',true);
  });}
  data=result;connected=true;hiddenRoundId=null;if(result.round)selectedMode=result.round.difficulty;
  if(animation==='sail'){const event=result.round.events.at(-1);if(event.lost?.length){showEvent(collision?.kind==='iceberg'?'Iceberg collision · all cargo lost':'Debris hit · Cargo '+event.lost.join(' + ')+' lost at stop '+result.round.step,true);}else{sound('arrive');showEvent('Stop '+result.round.step+' reached · '+mult(result.round.multiplier100));}}
  if(animation==='collect'){const event=result.round.events.at(-1),amount=Object.values(event.credits).reduce((a,b)=>a+b,0);sound('collect');showEvent(money(amount)+' secured');}
  if(path==='/api/reset'){hiddenRoundId=data.round?.id||null;toast('Play balance refilled to $1,000.00.');}
 }catch(e){toast(e.message,true);try{await sync();}catch{offline();}}
 finally{busy=false;render();}
}
async function collect(id){const r=visibleRound();if(r?.status==='active')await action('/api/rounds/'+r.id+'/collect',{containerId:id},'collect');}
$('sail-button').addEventListener('click',async()=>{
 if(!data||busy)return;const r=visibleRound();sound('click');
 if(!r){const stake=parseStake();if(stake===null)return toast('Enter a bet with up to two decimal places.',true);await action('/api/rounds',{difficulty:selectedMode,stakeCents:stake,clientSeed,expectedSeedHash:data.session.nextSeedHash});}
 else if(r.status==='settled'){hiddenRoundId=r.id;$('scene-event').hidden=true;render();$('bet-amount').focus();}
 else if(r.step===r.maxStops)await collect('all');
 else await action('/api/rounds/'+r.id+'/advance',{},'sail');
});
$('collect-all').addEventListener('click',()=>collect('all'));
$('bet-amount').addEventListener('input',()=>{if(!isActive()){hiddenRoundId=data?.round?.id||null;render();}});
$('bet-amount').addEventListener('blur',()=>{const n=parseStake();if(n!==null)$('bet-amount').value=(n/100).toFixed(2);});
for(const [id,f]of [['half-bet',.5],['double-bet',2]])$(id).addEventListener('click',()=>{const n=parseStake()??3000;$('bet-amount').value=(Math.max(RULES.minBetCents,Math.min(RULES.maxBetCents,Math.round(n*f)))/100).toFixed(2);hiddenRoundId=data?.round?.id||null;render();});
$('sound-button').addEventListener('click',()=>{soundEnabled=!soundEnabled;localStorage.setItem('cargo-sound',soundEnabled?'on':'off');soundButton();sound('click');});soundButton();

function openModal(title,html){$('modal-title').textContent=title;$('modal-content').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
$('close-modal').addEventListener('click',()=>$('modal').close());
$('modal').addEventListener('click',event=>{const r=$('modal').getBoundingClientRect();if(event.target===$('modal')&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))$('modal').close();});
$('rules-button').addEventListener('click',()=>{
 let rows='';for(let i=0;i<19;i++)rows+='<tr><td>'+String(i+1).padStart(2,'0')+'</td>'+Object.values(MODES).map(m=>'<td>'+(m.payouts[i]?mult(m.payouts[i]):'—')+'</td>').join('')+'</tr>';
 openModal('How to play',`<ol><li><strong>Choose your bet and difficulty.</strong> Your total bet splits into three containers. If it cannot divide evenly, the extra cents go to A, then B.</li><li><strong>Set sail, then advance one stop at a time.</strong> Each container has its own independently generated hazard route. The loss chance rises at every stop.</li><li><strong>Collect containers separately.</strong> A collected payout stays in your balance. A lost container returns nothing. You can also collect every remaining container together.</li><li><strong>Reach the final port.</strong> Easy has 19 stops, Medium 17, Hard 15 and Expert 10. At the last stop, collect the surviving cargo to settle the voyage.</li></ol><p>The figures below are total-return multipliers. A $10.00 container collected at 1.29× returns $12.90, including its stake. Payouts round to the nearest cent, half up.</p><h3>Every stop and multiplier</h3><div class="table-wrap"><table class="payout-table"><thead><tr><th>Stop</th><th>Easy</th><th>Medium</th><th>Hard</th><th>Expert</th></tr></thead><tbody>${rows}</tbody></table></div><p>This build uses play money and a local wallet. Your voyage survives a refresh. The Fairness panel can reproduce each settled round.</p>`);
});
function proofHtml(r){const proof=r?.proof,fields=proof?[
 ['Server seed commitment',proof.serverSeedHash],['Client seed',proof.clientSeed],['Nonce',proof.nonce],['Server seed',proof.serverSeed||'Hidden until every container is collected or lost.']
 ]:[['Next server seed commitment',data.session.nextSeedHash]];
 return fields.map(([label,value])=>`<div class="proof-row"><span>${label}</span><code>${esc(value)}</code></div>`).join('');}
function fairness(r=visibleRound()){
 if(!data)return;modalRound=r;
 openModal(r?'Round fairness':'Before your next voyage',`<p>The server commits to a seed before you bet. Each container gets a separate hazard deck from that seed, your client seed and the round nonce. After settlement, the server seed is revealed so your browser can independently reproduce the voyage.</p>${proofHtml(r)}${r?`<div class="modal-actions"><button id="verify-proof" class="primary" ${r.status!=='settled'?'disabled':''}>Verify round</button><button id="download-proof" class="secondary" ${r.status!=='settled'?'disabled':''}>Export proof</button></div><div id="proof-result" hidden></div>`:`<h3>Your client seed</h3><label for="client-seed-input">Set before placing the bet</label><input id="client-seed-input" maxlength="128" value="${esc(clientSeed)}"><div class="modal-actions"><button id="save-client-seed" class="primary">Save client seed</button></div>`}`);
 $('verify-proof')?.addEventListener('click',async()=>{const b=$('verify-proof');b.disabled=true;b.textContent='Verifying…';const result=await verifyRound(modalRound),output=$('proof-result');output.hidden=false;output.className='proof-result'+(result.valid?'':' error');output.textContent=result.message;b.textContent=result.valid?'✓ Round verified':'Verify round';b.disabled=false;});
 $('download-proof')?.addEventListener('click',()=>downloadRound(modalRound));
 $('save-client-seed')?.addEventListener('click',()=>{const value=$('client-seed-input').value;if(!value.length)return toast('Enter a client seed.',true);clientSeed=value;localStorage.setItem('cargo-client-seed',value);$('modal').close();toast('Client seed saved for the next voyage.');});
}
$('fairness-button').addEventListener('click',()=>fairness());$('verify-result').addEventListener('click',()=>fairness());
$('history-button').addEventListener('click',()=>{
 if(!data)return;
 const history=data.history;openModal('Your voyage history',history.length?`<p>Your latest 20 settled voyages. Select a round to inspect or verify it.</p>${history.map(r=>`<div class="history-row"><div><strong>${MODES[r.difficulty].name} · stop ${r.step}</strong><small>${esc(new Date(r.finishedAt).toLocaleString())}</small></div><div><strong class="${r.netCents>=0?'positive':'negative'}">${r.netCents>=0?'+':'−'}${money(Math.abs(r.netCents))}</strong><small>${money(r.stakeCents)} bet · ${money(r.returnedCents)} returned</small></div><button class="secondary" data-round="${r.id}">Inspect</button></div>`).join('')}`:'<div class="empty-state">Your completed voyages will appear here.<br>Start your first voyage to create a record.</div>');
 document.querySelectorAll('[data-round]').forEach(b=>b.addEventListener('click',async()=>{try{const result=await api('/api/rounds/'+b.dataset.round);fairness(result.round);}catch(e){toast(e.message,true)}}));
});
$('refill-button').addEventListener('click',()=>{
 if(isActive())return toast('Finish your voyage before refilling.',true);
 openModal('Refill your play balance',`<p>Set your play balance to <strong>$1,000.00</strong>. Your completed voyages and fairness proofs stay saved.</p><div class="modal-actions"><button id="confirm-refill" class="primary">Refill to $1,000.00</button><button id="cancel-refill" class="secondary">Keep current balance</button></div>`);
 $('cancel-refill').addEventListener('click',()=>$('modal').close());$('confirm-refill').addEventListener('click',async()=>{$('modal').close();await action('/api/reset');});
});
function downloadRound(round){if(!round||round.status!=='settled')return;const url=URL.createObjectURL(new Blob([JSON.stringify(round,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='cargo-round-'+round.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-round').addEventListener('click',()=>downloadRound(visibleRound()));
document.addEventListener('visibilitychange',async()=>{if(!document.hidden&&!busy)try{await sync();}catch{offline();}});
setInterval(async()=>{if(!busy&&!document.hidden&&data)try{const next=await api('/api/session');if(next.session.revision!==data.session.revision||!connected){data=next;connected=true;render();toast('Voyage synchronized.');}}catch{offline();}},12000);
document.body.classList.add('loading');sync().catch(e=>{offline();toast('Could not connect. Please refresh the page in a moment.',true);});

// Structured access uses the same visible, play-money actions.
if (document.modelContext?.registerTool) {
 const lifecycle=new AbortController(),context=document.modelContext;
 const state=()=>({mode:visibleRound()?.difficulty||selectedMode,step:visibleRound()?.step||0,status:visibleRound()?.status||'ready',balanceCents:data?.session.balanceCents,containers:visibleRound()?.containers.map(({id,status,valueCents})=>({id,status,valueCents}))||[]});
 const register=(name,description,inputSchema,execute,readOnly=false)=>{
  try{Promise.resolve(context.registerTool({name,description,inputSchema,annotations:{readOnlyHint:readOnly},execute},{signal:lifecycle.signal})).catch(()=>{});}catch{}
 };
 const empty={type:'object',properties:{},additionalProperties:false};
 register('cargo_get_state','Read this play-money prototype wallet and visible voyage.',empty,()=>state(),true);
 register('cargo_place_play_bet','Place a new play-money voyage bet. No real money is used.',{type:'object',properties:{difficulty:{type:'string',enum:Object.keys(MODES)},stakeCents:{type:'integer',minimum:RULES.minBetCents,maximum:RULES.maxBetCents}},required:['difficulty','stakeCents'],additionalProperties:false},async input=>{
  if(!data||busy||isActive()||!Object.hasOwn(MODES,input.difficulty)||!Number.isSafeInteger(input.stakeCents)||input.stakeCents<RULES.minBetCents||input.stakeCents>RULES.maxBetCents||input.stakeCents>data.session.balanceCents)throw new Error('Cannot place this play-money bet.');
  selectedMode=input.difficulty;hiddenRoundId=data.round?.id||null;$('bet-amount').value=(input.stakeCents/100).toFixed(2);render();const before=data.round?.id;
  await action('/api/rounds',{difficulty:selectedMode,stakeCents:input.stakeCents,clientSeed,expectedSeedHash:data.session.nextSeedHash});
  if(data.round?.id===before)throw new Error('The play-money bet was not placed.');return state();
 });
 register('cargo_sail_one_stop','Attempt one more stop with the remaining play-money cargo.',empty,async()=>{
  const r=visibleRound();if(busy||r?.status!=='active'||r.step>=r.maxStops)throw new Error('No further stop is available.');
  const before=r.step;await action('/api/rounds/'+r.id+'/advance',{},'sail');if(visibleRound()?.step===before)throw new Error('The stop was not advanced.');return state();
 });
 register('cargo_collect_play_cargo','Collect one or all remaining play-money containers.',{type:'object',properties:{containerId:{type:'string',enum:['A','B','C','all']}},required:['containerId'],additionalProperties:false},async input=>{
  const r=visibleRound();if(busy||r?.status!=='active'||r.step<1||!['A','B','C','all'].includes(input.containerId)||!r.containers.some(c=>c.status==='onboard'&&(input.containerId==='all'||c.id===input.containerId)))throw new Error('This cargo cannot be collected.');
  const before=r.returnedCents;await collect(input.containerId);if(visibleRound()?.returnedCents===before)throw new Error('The cargo was not collected.');return state();
 });
 addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
