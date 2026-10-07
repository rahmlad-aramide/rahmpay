import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { config } from '../config';
import { requirePublicKey, requireSecretKey } from '../middleware/auth';
import { initializeSchema, chargeSchema, otpSchema } from '../schemas';
import { newId, hmac256, safeEqual } from '../lib/crypto';
import { luhnValid, detectBrand, isExpired } from '../lib/card';
import { AppError } from '../lib/errors';
import { authorize } from '../services/mockBank';
import { getByAccessCode, serialize, transition, type Transaction } from '../services/transactions';
import { queueWebhook } from '../services/webhooks';

export const gateway = Router();

// Card endpoints get a much tighter limit than the rest of the API (card-testing / brute-force protection)
const paymentLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });

const ok = (message: string, data: unknown) => ({ status: true, message, data });

/* ------------------------- Server-to-server (secret key) ------------------------- */

gateway.post('/transaction/initialize', requireSecretKey, (req, res) => {
  const body = initializeSchema.parse(req.body);
  const merchant = req.merchant!;
  const idemKey = req.header('idempotency-key') ?? null;

  // Idempotency: same key => same transaction, so a retried request never creates a duplicate payment
  if (idemKey) {
    const existing = db
      .prepare('SELECT * FROM transactions WHERE merchant_id = ? AND idempotency_key = ?')
      .get(merchant.id, idemKey) as Transaction | undefined;
    if (existing) {
      if (existing.amount_kobo !== body.amount || existing.email !== body.email) {
        throw new AppError(409, 'Idempotency-Key reused with a different payload', 'idempotency_conflict');
      }
      return res.json(ok('Authorization URL created', { reference: existing.reference, access_code: existing.access_code }));
    }
  }

  const reference = body.reference ?? newId('RP', 9);
  const accessCode = newId('ac', 16);
  const tx = {
    id: newId('TRX'),
    merchant_id: merchant.id,
    reference,
    access_code: accessCode,
    access_expires_at: new Date(Date.now() + config.accessCodeTtlMinutes * 60_000).toISOString(),
    idempotency_key: idemKey,
    amount_kobo: body.amount,
    currency: body.currency,
    email: body.email,
    metadata: body.metadata ? JSON.stringify(body.metadata) : null,
  };
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (id, merchant_id, reference, access_code, access_expires_at, idempotency_key, amount_kobo, currency, email, status, metadata)
         VALUES (@id, @merchant_id, @reference, @access_code, @access_expires_at, @idempotency_key, @amount_kobo, @currency, @email, 'initialized', @metadata)`
      ).run(tx);
      db.prepare(`INSERT INTO transaction_events (transaction_id, to_status, note) VALUES (?, 'initialized', 'Created by merchant')`).run(tx.id);
    })();
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(409, 'Duplicate transaction reference', 'duplicate_reference');
    throw e;
  }
  res.status(201).json(ok('Authorization URL created', { reference, access_code: accessCode }));
});

gateway.get('/transaction/verify/:reference', requireSecretKey, (req, res) => {
  const tx = db
    .prepare('SELECT * FROM transactions WHERE reference = ? AND merchant_id = ?')
    .get(req.params.reference, req.merchant!.id) as Transaction | undefined;
  if (!tx) throw new AppError(404, 'Transaction reference not found', 'not_found');
  res.json(ok('Verification successful', serialize(tx)));
});

gateway.get('/transaction', requireSecretKey, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50')
    .all(req.merchant!.id) as Transaction[];
  res.json(ok('Transactions retrieved', rows.map(serialize)));
});

gateway.get('/transaction/:reference/timeline', requireSecretKey, (req, res) => {
  const tx = db
    .prepare('SELECT id FROM transactions WHERE reference = ? AND merchant_id = ?')
    .get(req.params.reference, req.merchant!.id) as { id: string } | undefined;
  if (!tx) throw new AppError(404, 'Transaction reference not found', 'not_found');
  const events = db
    .prepare('SELECT from_status, to_status, note, created_at FROM transaction_events WHERE transaction_id = ? ORDER BY id')
    .all(tx.id);
  res.json(ok('Timeline retrieved', events));
});

/* ------------------------- Client-side (public key + access code) ------------------------- */

gateway.get('/checkout/:accessCode', requirePublicKey, (req, res) => {
  const tx = getByAccessCode(String(req.params.accessCode), req.merchant!.id);
  res.json(
    ok('Checkout session', {
      merchant: req.merchant!.name,
      reference: tx.reference,
      amount: tx.amount_kobo,
      currency: tx.currency,
      email: tx.email,
      status: tx.status,
      expires_at: tx.access_expires_at,
    })
  );
});

gateway.post('/charge', paymentLimiter, requirePublicKey, async (req, res) => {
  const { access_code, card } = chargeSchema.parse(req.body);
  const merchant = req.merchant!;
  const tx = getByAccessCode(access_code, merchant.id);
  if (tx.status !== 'initialized') throw new AppError(409, `Transaction already ${tx.status}`, 'invalid_state');

  // Validate before touching state so the customer can fix typos
  if (!luhnValid(card.number)) throw new AppError(400, 'Invalid card number', 'invalid_card');
  if (isExpired(card.expiry_month, card.expiry_year)) throw new AppError(400, 'Card has expired', 'expired_card');

  // Lock the transaction (initialized -> pending). A concurrent second charge request fails here.
  transition(tx, 'pending', 'Card charge started', { channel: 'card' });

  // Tokenize: keep only non-sensitive card data. PAN lives only in memory for this request; CVV is never stored.
  const tokenId = newId('AUTH', 10);
  db.prepare(
    `INSERT INTO card_tokens (id, merchant_id, fingerprint, last4, bin, brand, exp_month, exp_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tokenId, merchant.id, hmac256(card.number), card.number.slice(-4), card.number.slice(0, 6), detectBrand(card.number), card.expiry_month, card.expiry_year);
  db.prepare('UPDATE transactions SET card_token_id = ? WHERE id = ?').run(tokenId, tx.id);
  tx.card_token_id = tokenId;

  const decision = await authorize(card.number, tx.amount_kobo);

  if (decision.result === 'approved') {
    transition(tx, 'success', decision.message, { gateway_response: decision.message, paid_at: new Date().toISOString() });
    queueWebhook(merchant, tx, 'charge.success');
  } else if (decision.result === 'otp_required') {
    db.prepare(
      `INSERT OR REPLACE INTO otp_challenges (transaction_id, otp_hash, expires_at, attempts) VALUES (?, ?, ?, 0)`
    ).run(tx.id, hmac256(`${tx.id}:${decision.otp}`), new Date(Date.now() + config.otpTtlMinutes * 60_000).toISOString());
    transition(tx, 'send_otp', 'Issuer requested OTP', { gateway_response: decision.message });
  } else {
    transition(tx, 'failed', decision.message, { gateway_response: decision.message });
    queueWebhook(merchant, tx, 'charge.failed');
  }

  res.json(ok('Charge attempted', { reference: tx.reference, status: tx.status, display_text: decision.message }));
});

gateway.post('/charge/submit_otp', paymentLimiter, requirePublicKey, (req, res) => {
  const { access_code, otp } = otpSchema.parse(req.body);
  const merchant = req.merchant!;
  const tx = getByAccessCode(access_code, merchant.id);
  if (tx.status !== 'send_otp') throw new AppError(409, 'Transaction is not awaiting OTP', 'invalid_state');

  const challenge = db.prepare('SELECT * FROM otp_challenges WHERE transaction_id = ?').get(tx.id) as
    | { otp_hash: string; expires_at: string; attempts: number }
    | undefined;
  if (!challenge) throw new AppError(409, 'No OTP challenge', 'invalid_state');

  if (new Date(challenge.expires_at) < new Date()) {
    transition(tx, 'failed', 'OTP expired', { gateway_response: 'OTP expired' });
    queueWebhook(merchant, tx, 'charge.failed');
    return res.json(ok('OTP expired', { reference: tx.reference, status: tx.status, display_text: 'OTP expired' }));
  }

  if (!safeEqual(hmac256(`${tx.id}:${otp}`), challenge.otp_hash)) {
    const attempts = challenge.attempts + 1;
    db.prepare('UPDATE otp_challenges SET attempts = ? WHERE transaction_id = ?').run(attempts, tx.id);
    if (attempts >= config.otpMaxAttempts) {
      transition(tx, 'failed', 'Too many wrong OTP attempts', { gateway_response: 'Too many wrong OTP attempts' });
      queueWebhook(merchant, tx, 'charge.failed');
      return res.json(ok('OTP attempts exhausted', { reference: tx.reference, status: tx.status, display_text: 'Too many wrong OTP attempts' }));
    }
    throw new AppError(400, `Incorrect OTP. ${config.otpMaxAttempts - attempts} attempt(s) left`, 'invalid_otp');
  }

  db.prepare('DELETE FROM otp_challenges WHERE transaction_id = ?').run(tx.id);
  transition(tx, 'success', 'OTP verified, approved', { gateway_response: 'Approved', paid_at: new Date().toISOString() });
  queueWebhook(merchant, tx, 'charge.success');
  res.json(ok('Charge successful', { reference: tx.reference, status: tx.status, display_text: 'Approved' }));
});
