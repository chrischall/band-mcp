import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPathAndQuery, computeMd, signRequest, signingKey } from '../src/sign.js';

// A made-up base64url secret (NOT a real BAND key).
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');

describe('buildPathAndQuery', () => {
  it('puts ts first, then the params in insertion order', () => {
    expect(buildPathAndQuery('/v2.0.0/get_post', 1_700_000_000_123, { band_no: 42, post_no: 7 })).toBe(
      '/v2.0.0/get_post?ts=1700000000123&band_no=42&post_no=7',
    );
  });

  it('URL-encodes values and encodes an apostrophe as %27', () => {
    expect(buildPathAndQuery('/v2.0.0/search_posts', 1, { band_no: 1, query: "rock'n roll & co" })).toBe(
      '/v2.0.0/search_posts?ts=1&band_no=1&query=rock%27n+roll+%26+co',
    );
  });

  it('JSON-encodes object/array values', () => {
    expect(buildPathAndQuery('/x', 1, { calendars: [{ is_default: true }] })).toBe(
      `/x?ts=1&calendars=${encodeURIComponent('[{"is_default":true}]')}`,
    );
  });

  it('stringifies booleans and drops undefined values', () => {
    expect(buildPathAndQuery('/x', 1, { a: false, b: undefined, c: 'y' })).toBe('/x?ts=1&a=false&c=y');
  });

  it('an empty param set signs just the ts', () => {
    expect(buildPathAndQuery('/v2.1.0/get_profile', 5)).toBe('/v2.1.0/get_profile?ts=5');
  });
});

describe('signingKey', () => {
  it('base64url-decodes the secret when isJwtType', () => {
    expect(signingKey(SECRET, true).equals(Buffer.from('0123456789abcdef0123456789abcdef'))).toBe(true);
  });

  it('uses the utf8 bytes of the secret otherwise', () => {
    expect(signingKey('plain-secret', false).equals(Buffer.from('plain-secret', 'utf8'))).toBe(true);
  });
});

describe('computeMd', () => {
  it('is base64 HMAC-SHA256 over the exact path?query', () => {
    const key = signingKey(SECRET, true);
    const pathAndQuery = '/v2.1.0/get_profile?ts=1700000000123';
    const expected = createHmac('sha256', key).update(pathAndQuery).digest('base64');
    expect(computeMd(key, pathAndQuery)).toBe(expected);
  });
});

describe('signRequest', () => {
  it('returns the path?query and its md', () => {
    const signed = signRequest({ endpoint: '/v2.0.0/get_post', params: { band_no: 1 }, ts: 9, secretKey: SECRET, isJwt: true });
    expect(signed.pathAndQuery).toBe('/v2.0.0/get_post?ts=9&band_no=1');
    expect(signed.md).toBe(
      createHmac('sha256', Buffer.from(SECRET, 'base64url')).update('/v2.0.0/get_post?ts=9&band_no=1').digest('base64'),
    );
  });
});
