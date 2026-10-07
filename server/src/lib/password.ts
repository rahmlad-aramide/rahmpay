import crypto from 'node:crypto';

const KEYLEN = 64;
// scrypt cost: N=2^15 is a sane interactive-login setting; maxmem must exceed 128*N*r
const OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const scrypt = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, OPTS, (err, key) => (err ? reject(err) : resolve(key)))
  );

/** Output: salt.hash (base64url). A fresh random salt per password, so equal passwords hash differently. */
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `${salt.toString('base64url')}.${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [saltB64, keyB64] = stored.split('.');
  if (!saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Verified against when the email is unknown, so "no such user" costs the same time as "wrong password"
export const DUMMY_HASH = hashPassword('dummy-password-for-timing');
