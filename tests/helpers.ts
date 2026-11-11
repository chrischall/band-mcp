// Shared test fixtures. No real credential: fake JWTs are unsigned base64url
// JSON with a dummy signature segment, and the secret is made up.

export const NOW_MS = 1_800_000_000_000;
export const NOW = NOW_MS / 1000;

/** A made-up base64url signing secret. */
export const SECRET = Buffer.from('fake-signing-secret-0123456789ab').toString('base64url');

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

/** A band_session JWT expiring `secondsLeft` after NOW. */
export const bandSessionJwt = (secondsLeft = 2 * 86_400) => fakeJwt({ exp: NOW + secondsLeft, iat: NOW - 3600 });

/** A getKey JSONP body shaped like BAND's (values made up). */
export function getKeyBody(opts: { t?: number; secretKey?: string; isJwt?: boolean; timeCorrection?: number | null; state?: string } = {}): string {
  const t = opts.t ?? 1;
  const secretKey = opts.secretKey ?? SECRET;
  const isJwt = opts.isJwt ?? true;
  const state = opts.state ?? 'USER';
  const tc = opts.timeCorrection === null ? '' : `, timeCorrection: ${opts.timeCorrection ?? NOW_MS + 5000}`;
  return `authCallBack_${t}({ secretKey : '${secretKey}', isJwtType : ${isJwt}${tc}, authenticateState : "${state}" });`;
}

/** The error a promise rejects with (fails the test if it resolves). */
export async function rejectionOf<E = Error>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (err) {
    return err as E;
  }
  throw new Error('expected a rejection');
}
