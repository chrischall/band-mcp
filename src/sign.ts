// BAND's request signature. Every API call carries an `md` header:
//
//   md = base64( HMAC-SHA256( key, pathAndQuery ) )
//
// where `pathAndQuery` is exactly the URL path + `?` + query string as sent —
// `ts` (epoch ms, server-corrected) FIRST, apostrophes as `%27` (the web app's
// encoder does that; URLSearchParams leaves them bare). A POST signs only its
// URL (`path?ts=<ms>`); the form body is not part of the signature. The key is
// the base64url-decoded per-session `secretKey` when getKey says `isJwtType`,
// else its utf8 bytes.

import { createHmac } from 'node:crypto';

/** A query value: scalars as text, objects/arrays as JSON, `undefined` dropped. */
export type QueryValue = string | number | boolean | object | undefined;
export type QueryParams = Record<string, QueryValue>;

function encodeValue(value: Exclude<QueryValue, undefined>): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** `endpoint?ts=<ts>&k=v…`, encoded the way BAND's web app encodes it. */
export function buildPathAndQuery(endpoint: string, ts: number, params: QueryParams = {}): string {
  const search = new URLSearchParams();
  search.append('ts', String(ts));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.append(k, encodeValue(v));
  }
  return `${endpoint}?${search.toString().replace(/'/g, '%27')}`;
}

/** The HMAC key bytes for a session's `secretKey`. */
export function signingKey(secretKey: string, isJwt: boolean): Buffer {
  return isJwt ? Buffer.from(secretKey, 'base64url') : Buffer.from(secretKey, 'utf8');
}

/** The `md` header value for `pathAndQuery`. */
export function computeMd(key: Buffer, pathAndQuery: string): string {
  return createHmac('sha256', key).update(pathAndQuery).digest('base64');
}

export interface SignRequestInput {
  endpoint: string;
  params?: QueryParams;
  ts: number;
  secretKey: string;
  isJwt: boolean;
}

export interface SignedRequest {
  pathAndQuery: string;
  md: string;
}

/** Build and sign one request URL. */
export function signRequest(input: SignRequestInput): SignedRequest {
  const pathAndQuery = buildPathAndQuery(input.endpoint, input.ts, input.params);
  return { pathAndQuery, md: computeMd(signingKey(input.secretKey, input.isJwt), pathAndQuery) };
}
