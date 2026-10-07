import { db } from '../db';
import { AppError } from '../lib/errors';

export type TxStatus = 'initialized' | 'pending' | 'send_otp' | 'success' | 'failed' | 'abandoned';

export type Transaction = {
  id: string;
  merchant_id: string;
  reference: string;
  access_code: string;
  access_expires_at: string;
  idempotency_key: string | null;
  amount_kobo: number;
  currency: string;
  email: string;
  status: TxStatus;
  channel: string | null;
  card_token_id: string | null;
  gateway_response: string | null;
  metadata: string | null;
  paid_at: string | null;
  created_at: string;
};

/** The only legal state changes. Anything else is rejected - e.g. a successful payment can never be re-charged. */
const TRANSITIONS: Record<TxStatus, TxStatus[]> = {
  initialized: ['pending', 'abandoned'],
  pending: ['send_otp', 'success', 'failed'],
  send_otp: ['success', 'failed', 'abandoned'],
  success: [],
  failed: [],
  abandoned: [],
};

export const isFinal = (s: TxStatus) => TRANSITIONS[s].length === 0;

export function getByAccessCode(accessCode: string, merchantId: string) {
  const tx = db
    .prepare('SELECT * FROM transactions WHERE access_code = ? AND merchant_id = ?')
    .get(accessCode, merchantId) as Transaction | undefined;
  if (!tx) throw new AppError(404, 'Transaction not found', 'not_found');
  if (!isFinal(tx.status) && new Date(tx.access_expires_at) < new Date()) {
    transition(tx, 'abandoned', 'Checkout session expired');
    throw new AppError(410, 'Checkout session expired', 'expired');
  }
  return tx;
}

/** Atomic state change + audit event. The WHERE status = ? guard prevents race conditions (double charge). */
export const transition = db.transaction(
  (tx: Transaction, to: TxStatus, note?: string, extra: Partial<Transaction> = {}) => {
    if (!TRANSITIONS[tx.status].includes(to)) {
      throw new AppError(409, `Cannot move transaction from ${tx.status} to ${to}`, 'invalid_state');
    }
    const fields = { ...extra, status: to };
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    const info = db
      .prepare(`UPDATE transactions SET ${sets}, updated_at = datetime('now') WHERE id = @id AND status = @from`)
      .run({ ...fields, id: tx.id, from: tx.status });
    if (info.changes !== 1) throw new AppError(409, 'Transaction was modified concurrently', 'conflict');
    db.prepare('INSERT INTO transaction_events (transaction_id, from_status, to_status, note) VALUES (?, ?, ?, ?)').run(
      tx.id,
      tx.status,
      to,
      note ?? null
    );
    Object.assign(tx, fields);
    return tx;
  }
);

/** Public shape returned by the API - never leaks internal ids or the access code to the merchant list endpoints. */
export function serialize(tx: Transaction) {
  const card = tx.card_token_id
    ? (db.prepare('SELECT id, last4, brand, exp_month, exp_year, bin FROM card_tokens WHERE id = ?').get(tx.card_token_id) as any)
    : null;
  return {
    reference: tx.reference,
    amount: tx.amount_kobo,
    currency: tx.currency,
    status: tx.status,
    email: tx.email,
    channel: tx.channel,
    gateway_response: tx.gateway_response,
    paid_at: tx.paid_at,
    created_at: tx.created_at,
    metadata: tx.metadata ? JSON.parse(tx.metadata) : null,
    authorization: card
      ? { authorization_code: card.id, last4: card.last4, bin: card.bin, brand: card.brand, exp_month: card.exp_month, exp_year: card.exp_year }
      : null,
  };
}
