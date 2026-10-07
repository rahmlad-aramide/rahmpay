import crypto from 'node:crypto';
import { config } from '../config';

/** Random, URL-safe identifiers (cryptographically secure, not Math.random). */
export const newId = (prefix: string, bytes = 12) =>
  `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** Keyed hash - used for card fingerprints and OTP hashes so a DB leak reveals nothing usable. */
export const hmac256 = (value: string) =>
  crypto.createHmac('sha256', config.masterKey).update(value).digest('hex');

/** HMAC-SHA512 signature for webhooks (same scheme Paystack uses). */
export const signPayload = (rawBody: string, secret: string) =>
  crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

/** Constant-time comparison - prevents timing attacks when checking signatures/hashes. */
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** AES-256-GCM authenticated encryption for secrets at rest. Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string) {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
