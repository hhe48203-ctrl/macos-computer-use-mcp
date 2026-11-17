import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Wire protocol between the container's RemoteBridge and the host broker.
// After a mutual HMAC handshake, request/response frames are the same NDJSON
// objects the Swift helper speaks, plus ping/pong/release/revoked controls.
export const protocolVersion = 1;
export const handshakeFrameBytes = 4096;
export const frame = value => JSON.stringify(value) + '\n';
export const createNonce = () => randomBytes(32).toString('base64url');
export const createToken = () => randomBytes(32).toString('base64url');
export const validToken = token => typeof token === 'string' && token.length >= 32 && token.length <= 512;
export const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);

/** Each role proves the shared token over both nonces without sending it. */
export function proof(token, role, brokerNonce, clientNonce) {
  return createHmac('sha256', token).update(`cu-broker-v${protocolVersion}\n${role}\n${brokerNonce}\n${clientNonce}`).digest('base64url');
}
export function sameProof(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function parse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}
export function wireError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'NATIVE_ERROR';
  return { code, message: String(error?.message ?? 'Native error').slice(0, 4000) };
}

/**
 * Splits newline-delimited frames. limit() is read per frame so a connection can
 * tighten it before authentication. onLine returning false stops processing.
 */
export function lineReader(limit, onLine, onOverflow) {
  let chunks = [], size = 0, stopped = false;
  return data => {
    if (stopped) return;
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      const piece = data.subarray(start, end);
      if (size + piece.length > limit()) { stopped = true; onOverflow(); return; }
      chunks.push(piece);
      const line = Buffer.concat(chunks).toString('utf8');
      chunks = []; size = 0; start = end + 1;
      if (onLine(line) === false) { stopped = true; return; }
    }
    const rest = data.subarray(start);
    if (size + rest.length > limit()) { stopped = true; onOverflow(); return; }
    if (rest.length) { chunks.push(rest); size += rest.length; }
  };
}
