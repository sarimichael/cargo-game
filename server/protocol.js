// Request-protocol helpers shared by the local (server/app.js) and hosted (server/worker.js) adapters.
import { createHash } from 'node:crypto';
import { GameError } from './game.js';

// Cloudflare D1 documents a 2,000,000-byte maximum for a string, BLOB or row.
export const MAX_SESSION_BODY_BYTES = 2000000;
// Space kept free so that any round accepted below the limit can always be settled.
// A worst-case round (Easy, 19 stops, three separate collections, maximum-length
// client seed and action IDs) adds well under a quarter of this; see audit/tests/remediation.test.js.
export const SETTLEMENT_RESERVE_BYTES = 65536;
export const MAX_REQUEST_BYTES = 16384;
// Real requests nest at most two levels. The limit is checked iteratively before anything
// recursive (JSON.parse, canonicalJSON, JSON.stringify) touches the body.
export const MAX_JSON_DEPTH = 32;

// Structural nesting depth of JSON text, counting only brackets outside strings.
function exceedsDepth(text, limit) {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === 92) escaped = true;          // backslash
      else if (ch === 34) inString = false;        // closing quote
    } else if (ch === 34) inString = true;
    else if (ch === 91 || ch === 123) { if (++depth > limit) return true; } // [ or {
    else if (ch === 93 || ch === 125) depth--;     // ] or }
  }
  return false;
}

// Decode a complete request body. Decoding once, after all chunks have arrived, keeps
// multi-byte characters intact across TCP chunk boundaries; malformed UTF-8 is refused.
export function parseJsonObject(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new GameError('Send valid UTF-8 text.'); }
  if (exceedsDepth(text, MAX_JSON_DEPTH)) throw new GameError('The request is nested too deeply.', 400, 'JSON_TOO_DEEP');
  try { const value = JSON.parse(text || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
  catch { throw new GameError('Send a JSON object.'); }
}

// Order-independent JSON so that a semantically identical retry has the same fingerprint.
// Serialised directly (no object rebuilding), so keys such as "__proto__" are handled as data.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = text => createHash('sha256').update(text).digest('hex');
export function actionFingerprint(path, input) {
  // `legacy` is the format stored before this change; it is still accepted so that
  // retries of actions recorded by an older deployment continue to replay.
  return { current: sha256('v2:' + canonicalJSON([path, input])), legacy: sha256(JSON.stringify([path, input])) };
}
// Own-property lookup: an action ID such as "constructor" must not resolve to Object.prototype.
export const findReceipt = (session, actionId) => (Object.hasOwn(session.receipts, actionId) ? session.receipts[actionId] : null);
export const receiptMatches = (receipt, fingerprint) => receipt.fingerprint === fingerprint.current || receipt.fingerprint === fingerprint.legacy;
// Action IDs are limited to [a-zA-Z0-9-], so "__proto__" cannot occur and assignment creates an own property.
export function recordReceipt(session, actionId, fingerprint) {
  session.receipts[actionId] = { fingerprint: fingerprint.current, at: new Date().toISOString() };
}
