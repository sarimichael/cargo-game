import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { GameError, createSession, beginRound, advanceRound, collectRound, resetWallet, snapshot, publicRound } from './game.js';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
const allowedFiles = new Set(['index.html','styles.css','app.js','scene.js','math.js','fairness.js','icon.svg','collision.js','iceberg.png','debris.png']);
function send(res, status, payload) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' }); res.end(JSON.stringify(payload)); }
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new GameError('Request is too large.',413); }
  try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new GameError('Send a JSON object.'); }
}
export function createApp(store) {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const address = new URL(req.url, 'http://localhost');
      const host = req.headers.host;
      // Refuse DNS-rebinding hosts and cross-origin wallet mutations.
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) throw new GameError('Use the local Cargo address.',403);
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new GameError('Cross-origin requests are not allowed.',403);
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('Cross-site requests are not allowed.',403);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new GameError('Use application/json.',415);
      }
      if (address.pathname === '/api/health' && req.method === 'GET') return send(res,200,{ status:'ok',game:'Cargo',mode:'play-money' });
      if (!address.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new GameError('Method not allowed.',405);
        const file = address.pathname === '/' ? 'index.html' : address.pathname.slice(1);
        if (!allowedFiles.has(file)) throw new GameError('File not found.',404);
        const content = fs.readFileSync(path.join(publicPath,file));
        res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache'});res.end(req.method === 'HEAD' ? undefined : content);return;
      }
      const match = /(?:^|;\s*)cargo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
      let id = match?.[1], session = id ? store.get(id) : null;
      if (address.pathname === '/api/session' && req.method === 'GET') {
        if (!session) {
          id = randomBytes(32).toString('hex');
          store.transaction(state => { state.sessions[id] = createSession(id); }); session = store.get(id);
          res.setHeader('Set-Cookie','cargo_session='+id+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
        }
        return send(res,200,snapshot(session));
      }
      if (!session) throw new GameError('Your session expired. Refresh the game.',401,'SESSION_EXPIRED');
      const roundRoute = /^\/api\/rounds\/([a-f0-9-]{36})(?:\/(advance|collect))?$/.exec(address.pathname);
      if (roundRoute && !roundRoute[2] && req.method === 'GET') {
        if (!session.rounds[roundRoute[1]]) throw new GameError('Voyage not found.',404);
        return send(res,200,{ round:publicRound(session.rounds[roundRoute[1]]) });
      }
      if (req.method !== 'POST') throw new GameError('Endpoint not found.',404);
      const input = await body(req);
      if (typeof input.actionId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.actionId)) throw new GameError('Supply a unique action ID.');
      if (!Number.isSafeInteger(input.revision)) throw new GameError('Supply the current session revision.');
      const fingerprint = createHash('sha256').update(JSON.stringify([address.pathname,input])).digest('hex');
      const result = store.transaction(state => {
        const s = state.sessions[id], receipt = s.receipts[input.actionId];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new GameError('Action ID was reused for a different request.',409);
          return { ...snapshot(s), replayed:true };
        }
        if (s.revision !== input.revision) throw new GameError('Another action changed your voyage. The latest state has been restored.',409,'STALE_REVISION');
        if (address.pathname === '/api/rounds') beginRound(s,input);
        else if (roundRoute?.[2] === 'advance') advanceRound(s,roundRoute[1]);
        else if (roundRoute?.[2] === 'collect') collectRound(s,roundRoute[1],input.containerId);
        else if (address.pathname === '/api/reset') resetWallet(s);
        else throw new GameError('Endpoint not found.',404);
        s.revision++; s.receipts[input.actionId] = { fingerprint, at:new Date().toISOString() };
        return snapshot(s);
      });
      send(res,200,result);
    } catch (error) {
      if (!(error instanceof GameError)) console.error('Cargo request failed:',error.message);
      send(res,error.status || 500,{ error:error instanceof GameError ? error.message : 'The game could not save this action. Try again.',code:error.code || 'SERVER_ERROR' });
    }
  });
}
