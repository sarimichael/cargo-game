import { randomBytes } from 'node:crypto';
import { GameError, createSession, beginRound, advanceRound, collectRound, resetWallet, snapshot, publicRound } from './game.js';
import { MAX_REQUEST_BYTES, MAX_SESSION_BODY_BYTES, SETTLEMENT_RESERVE_BYTES, parseJsonObject, actionFingerprint, findReceipt, receiptMatches, recordReceipt } from './protocol.js';

const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(status,data,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,...extra}});
async function readBody(request) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new GameError('Use application/json.',415);
  if(Number(request.headers.get('content-length')||0)>MAX_REQUEST_BYTES)throw new GameError('Request is too large.',413);
  let total=0;const chunks=[],reader=request.body?.getReader();
  if(reader)for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_REQUEST_BYTES){await reader.cancel();throw new GameError('Request is too large.',413)}chunks.push(value)}
  const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength}
  return parseJsonObject(bytes);
}
async function load(db,id){const row=await db.prepare('SELECT body, revision FROM cargo_sessions WHERE id = ?').bind(id).first();return row?{session:JSON.parse(row.body),revision:row.revision,body:row.body}:null;}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    try{
      if(!env.DB)throw new Error('Game database is not configured.');
      const db=env.DB.withSession?env.DB.withSession('first-primary'):env.DB;
      if(url.pathname==='/api/health')return json(200,{status:'ok',game:'Cargo',mode:'play-money'});
      if(request.method==='POST'&&((request.headers.get('origin')&&request.headers.get('origin')!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site'))throw new GameError('Cross-origin requests are not allowed.',403);
      const cookie=/(?:^|;\s*)cargo_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'');
      let id=cookie?.[1],record=id?await load(db,id):null;
      if(url.pathname==='/api/session'&&request.method==='GET'){
        if(!record){
          id=randomBytes(32).toString('hex');const session=createSession(id);
          await db.prepare('INSERT INTO cargo_sessions (id,revision,body) VALUES (?,?,?)').bind(id,0,JSON.stringify(session)).run();
          const secure=url.protocol==='https:'?'; Secure':'';
          return json(200,snapshot(session),{'Set-Cookie':'cargo_session='+id+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+secure});
        }
        return json(200,snapshot(record.session));
      }
      if(!record)throw new GameError('Your session expired. Refresh the game.',401,'SESSION_EXPIRED');
      const route=/^\/api\/rounds\/([a-f0-9-]{36})(?:\/(advance|collect))?$/.exec(url.pathname);
      if(request.method==='GET'&&route&&!route[2]){
        const round=record.session.rounds[route[1]];if(!round)throw new GameError('Voyage not found.',404);
        return json(200,{round:publicRound(round)});
      }
      if(request.method!=='POST')throw new GameError('Endpoint not found.',404);
      const input=await readBody(request);
      if(typeof input.actionId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.actionId)||!Number.isSafeInteger(input.revision))throw new GameError('Supply an action ID and current revision.');
      const fingerprint=actionFingerprint(url.pathname,input),s=record.session,prior=findReceipt(s,input.actionId);
      if(prior){if(!receiptMatches(prior,fingerprint))throw new GameError('Action ID was reused.',409);return json(200,{...snapshot(s),replayed:true})}
      if(s.revision!==input.revision)throw new GameError('Another action changed your voyage. The latest state has been restored.',409,'STALE_REVISION');
      if(url.pathname==='/api/rounds'){
        // Refuse a new wager unless the stored session can still absorb its complete settlement.
        if(new TextEncoder().encode(record.body).byteLength+SETTLEMENT_RESERVE_BYTES>MAX_SESSION_BODY_BYTES)throw new GameError('This play session has reached its storage limit, so a new voyage cannot start.',409,'SESSION_STORAGE_FULL');
        beginRound(s,input);
      }
      else if(route?.[2]==='advance')advanceRound(s,route[1]);
      else if(route?.[2]==='collect')collectRound(s,route[1],input.containerId);
      else if(url.pathname==='/api/reset')resetWallet(s);
      else throw new GameError('Endpoint not found.',404);
      s.revision++;recordReceipt(s,input.actionId,fingerprint);
      const result=await db.prepare('UPDATE cargo_sessions SET revision = ?, body = ? WHERE id = ? AND revision = ?').bind(s.revision,JSON.stringify(s),id,record.revision).run();
      if(result.meta.changes!==1){
        const latest=await load(db,id),receipt=latest&&findReceipt(latest.session,input.actionId);
        if(receipt&&receiptMatches(receipt,fingerprint))return json(200,{...snapshot(latest.session),replayed:true});
        throw new GameError('Another action changed your voyage. The latest state has been restored.',409,'STALE_REVISION');
      }
      return json(200,snapshot(s));
    }catch(error){
      if(!(error instanceof GameError))console.error('Cargo mobile request failed:',error.message);
      return json(error.status||500,{error:error instanceof GameError?error.message:'The game could not save this action. Try again.',code:error.code||'SERVER_ERROR'});
    }
  }
};
