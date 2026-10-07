/**
 * DEMO MERCHANT BACKEND (e.g. an online store) that integrates RahmPay.
 * In real life this is a separate service owned by the merchant. It lives here only to keep the demo to one process,
 * but it talks to the gateway over HTTP with its secret key exactly like an external merchant would.
 */
import { Router, type Request } from 'express';
import { db } from '../db';
import { config } from '../config';
import { checkoutSchema } from '../schemas';
import { safeEqual, signPayload } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { requireUser } from '../middleware/user';

export const merchant = Router();

// Prices live on the server. The app sends product ids + quantities, NEVER prices (prevents price tampering).
const CATALOG: Record<string, { name: string; price_kobo: number; emoji: string }> = {
  'p-001': { name: 'Wireless Earbuds', price_kobo: 2_500_000, emoji: '🎧' },
  'p-002': { name: 'Ankara Tote Bag', price_kobo: 850_000, emoji: '👜' },
  'p-003': { name: 'Smart Watch', price_kobo: 4_200_000, emoji: '⌚' },
  'p-004': { name: 'Power Bank 20,000mAh', price_kobo: 1_800_000, emoji: '🔋' },
};

async function gatewayCall(path: string, init: RequestInit = {}) {
  const res = await fetch(`${config.gatewayUrl}/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.demoMerchant.secretKey}`,
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new AppError(res.status, json.message ?? 'Gateway error', json.code);
  return json.data;
}

/** 404 (not 403) for someone else's order, so references can't be probed. */
function ownedOrder(reference: string, userId: string) {
  const order = db.prepare('SELECT * FROM merchant_orders WHERE reference = ? AND user_id = ?').get(reference, userId) as any;
  if (!order) throw new AppError(404, 'Order not found');
  return order;
}

merchant.get('/products', (_req, res) => {
  res.json(Object.entries(CATALOG).map(([id, p]) => ({ id, ...p })));
});

merchant.get('/config', requireUser, (_req, res) => {
  // The ONLY key a mobile app ever receives is the public key
  res.json({ public_key: config.demoMerchant.publicKey, merchant: 'Rahmlad Store' });
});

merchant.post('/checkout', requireUser, async (req, res) => {
  const { items } = checkoutSchema.parse(req.body);
  const user = req.user!;
  const email = user.email; // the receipt goes to the account's email; the client does not choose it
  let amount = 0;
  const lines = items.map(({ id, qty }) => {
    const p = CATALOG[id];
    if (!p) throw new AppError(400, `Unknown product ${id}`);
    amount += p.price_kobo * qty;
    return { id, name: p.name, qty, price_kobo: p.price_kobo };
  });

  // Namespaced per user: the gateway scopes idempotency by merchant, so two customers must never share a key space
  const idem = req.header('idempotency-key');
  const data = await gatewayCall('/transaction/initialize', {
    method: 'POST',
    headers: idem ? { 'idempotency-key': `${user.id}:${idem}` } : {},
    body: JSON.stringify({ email, amount, metadata: { items: lines } }),
  });

  db.prepare(
    `INSERT OR IGNORE INTO merchant_orders (reference, email, user_id, items, amount_kobo) VALUES (?, ?, ?, ?, ?)`
  ).run(data.reference, email, user.id, JSON.stringify(lines), amount);

  res.json({ reference: data.reference, access_code: data.access_code, amount });
});

/** Called by the app after checkout. The merchant VERIFIES with the gateway; it never trusts the app's word. */
merchant.post('/orders/:reference/confirm', requireUser, async (req, res) => {
  const order = ownedOrder(String(req.params.reference), req.user!.id);

  const tx = await gatewayCall(`/transaction/verify/${encodeURIComponent(order.reference)}`);
  const paid = tx.status === 'success' && tx.amount === order.amount_kobo && tx.currency === 'NGN';
  if (paid && order.status !== 'paid') {
    db.prepare(`UPDATE merchant_orders SET status = 'paid' WHERE reference = ?`).run(order.reference);
  } else if (tx.status === 'failed' && order.status === 'awaiting_payment') {
    db.prepare(`UPDATE merchant_orders SET status = 'failed' WHERE reference = ?`).run(order.reference);
  }
  res.json({ reference: order.reference, order_status: paid ? 'paid' : tx.status === 'failed' ? 'failed' : 'pending', transaction: tx });
});

/** Webhook receiver: verify the HMAC signature over the RAW body, then update idempotently. */
merchant.post('/webhook', (req: Request & { rawBody?: string }, res) => {
  const signature = req.header('x-rahmpay-signature') ?? '';
  const expected = signPayload(req.rawBody ?? '', config.demoMerchant.webhookSecret);
  if (!safeEqual(signature, expected)) return res.sendStatus(401);

  const { event, data } = req.body;
  const order = db.prepare('SELECT * FROM merchant_orders WHERE reference = ?').get(data.reference) as any;
  if (order) {
    if (event === 'charge.success' && data.amount === order.amount_kobo) {
      db.prepare(`UPDATE merchant_orders SET status = 'paid' WHERE reference = ?`).run(data.reference);
    } else if (event === 'charge.failed' && order.status === 'awaiting_payment') {
      db.prepare(`UPDATE merchant_orders SET status = 'failed' WHERE reference = ?`).run(data.reference);
    }
  }
  res.sendStatus(200); // acknowledge fast; heavy work belongs in a background job
});

/** The caller's own recent transactions, each verified with the gateway. Other customers' payments are never exposed. */
merchant.get('/transactions', requireUser, async (req, res) => {
  const refs = db
    .prepare('SELECT reference FROM merchant_orders WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20')
    .all(req.user!.id) as { reference: string }[];
  const results = await Promise.allSettled(refs.map((r) => gatewayCall(`/transaction/verify/${encodeURIComponent(r.reference)}`)));
  res.json(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
});

merchant.get('/transactions/:reference/timeline', requireUser, async (req, res) => {
  ownedOrder(String(req.params.reference), req.user!.id);
  res.json(await gatewayCall(`/transaction/${encodeURIComponent(String(req.params.reference))}/timeline`));
});
