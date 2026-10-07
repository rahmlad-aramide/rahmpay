import { db } from '../db';
import { decrypt, signPayload } from '../lib/crypto';
import { config } from '../config';
import type { Merchant } from '../middleware/auth';
import { serialize, type Transaction } from './transactions';

/**
 * Sends a signed event to the merchant. Retries with exponential backoff (2s, 4s, 8s...).
 * In production this would be a durable queue (BullMQ / SQS) so retries survive restarts.
 */
export function queueWebhook(merchant: Merchant, tx: Transaction, event: 'charge.success' | 'charge.failed') {
  if (!merchant.webhook_url) return;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO webhook_deliveries (transaction_id, event) VALUES (?, ?)')
    .run(tx.id, event);
  const body = JSON.stringify({ event, data: serialize(tx) });
  const signature = signPayload(body, decrypt(merchant.webhook_secret_enc));
  void attempt(Number(lastInsertRowid), merchant.webhook_url, body, signature, 1);
}

async function attempt(deliveryId: number, url: string, body: string, signature: string, n: number) {
  let status = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rahmpay-signature': signature },
      body,
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
  } catch {
    status = 0;
  }
  const delivered = status >= 200 && status < 300;
  const retryInMs = 1000 * 2 ** n;
  const willRetry = !delivered && n < config.webhookMaxAttempts;
  db.prepare(
    `UPDATE webhook_deliveries SET attempts = ?, last_status_code = ?, delivered = ?, next_retry_at = ? WHERE id = ?`
  ).run(n, status, delivered ? 1 : 0, willRetry ? new Date(Date.now() + retryInMs).toISOString() : null, deliveryId);
  if (willRetry) setTimeout(() => attempt(deliveryId, url, body, signature, n + 1), retryInMs);
}
