/** End-to-end check of the whole flow against a running server: `npm run dev` in one terminal, `npm run test:e2e` in another. */
import 'dotenv/config';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:4000';
const PK = process.env.DEMO_MERCHANT_PUBLIC_KEY!;
let failures = 0;

async function call(path: string, init: RequestInit & { key?: string; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.key || init.token ? { authorization: `Bearer ${init.key ?? init.token}` } : {}), ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
function check(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failures++; if (extra) console.log('      ', JSON.stringify(extra)); }
}
let TA = ''; // customer A's session token (set in main)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const card = (number: string) => ({ number, cvv: '408', expiry_month: '12', expiry_year: '30' });

async function checkout(idem?: string) {
  const r = await call('/merchant/checkout', {
    method: 'POST',
    token: TA,
    headers: idem ? { 'idempotency-key': idem } : {},
    body: JSON.stringify({ items: [{ id: 'p-001', qty: 1 }, { id: 'p-002', qty: 2 }] }),
  });
  return r.body as { reference: string; access_code: string; amount: number };
}

async function main() {
  // 0. Accounts: two customers, so ownership can be tested
  const stamp = Date.now();
  const emailA = `ada-${stamp}@example.com`, emailB = `bola-${stamp}@example.com`, pw = 'correct horse battery';
  const regA = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: emailA, password: pw }) });
  check('register -> 201 + token', regA.status === 201 && String(regA.body?.token).startsWith('st_'), regA.body);
  TA = regA.body.token;
  const regB = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: emailB, password: pw }) });
  const TB = regB.body.token as string;
  const dup = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: emailA, password: pw }) });
  check('duplicate email rejected', dup.status === 409, dup.body);
  const badPw = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: emailA, password: 'wrong-password' }) });
  const noUser = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: `nobody-${stamp}@example.com`, password: 'wrong-password' }) });
  check('wrong password and unknown email give the same 401 message', badPw.status === 401 && noUser.status === 401 && badPw.body?.message === noUser.body?.message, [badPw.body, noUser.body]);
  const weak = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: `weak-${stamp}@example.com`, password: 'short' }) });
  check('short password rejected', weak.status === 400, weak.body);
  const anon = await call('/merchant/transactions');
  check('merchant endpoints require sign-in', anon.status === 401, anon.body);

  // 1. Happy path
  const a = await checkout();
  check('merchant computes amount server-side', a.amount === 2_500_000 + 2 * 850_000, a);
  const s = await call('/v1/charge', { method: 'POST', key: PK, body: JSON.stringify({ access_code: a.access_code, card: card('4084084084084081') }) });
  check('success card -> success', s.body?.data?.status === 'success', s.body);
  const c = await call(`/merchant/orders/${a.reference}/confirm`, { method: 'POST', token: TA });
  check('merchant server-side verify -> paid', c.body?.order_status === 'paid', c.body);
  check('verify response has no PAN, only last4', c.body?.transaction?.authorization?.last4 === '4081' && !JSON.stringify(c.body).includes('4084084084084081'));
  const again = await call('/v1/charge', { method: 'POST', key: PK, body: JSON.stringify({ access_code: a.access_code, card: card('4084084084084081') }) });
  check('cannot charge a completed transaction twice', again.status === 409, again.body);
  const steal = await call(`/merchant/orders/${a.reference}/confirm`, { method: 'POST', token: TB });
  check("another customer cannot confirm someone else's order", steal.status === 404, steal.body);
  const listB = await call('/merchant/transactions', { token: TB });
  check("another customer's history excludes my payments", Array.isArray(listB.body) && !listB.body.some((t: any) => t.reference === a.reference), listB.body);
  const listA = await call('/merchant/transactions', { token: TA });
  check('my history includes my payment', Array.isArray(listA.body) && listA.body.some((t: any) => t.reference === a.reference), listA.body);

  // 2. OTP path with one wrong attempt
  const b = await checkout();
  const o = await call('/v1/charge', { method: 'POST', key: PK, body: JSON.stringify({ access_code: b.access_code, card: card('5060666666666666666') }) });
  check('verve card -> send_otp', o.body?.data?.status === 'send_otp', o.body);
  const wrong = await call('/v1/charge/submit_otp', { method: 'POST', key: PK, body: JSON.stringify({ access_code: b.access_code, otp: '000000' }) });
  check('wrong OTP rejected with attempts left', wrong.status === 400, wrong.body);
  const right = await call('/v1/charge/submit_otp', { method: 'POST', key: PK, body: JSON.stringify({ access_code: b.access_code, otp: '123456' }) });
  check('correct OTP -> success', right.body?.data?.status === 'success', right.body);

  // 3. Declined
  const d = await checkout();
  const f = await call('/v1/charge', { method: 'POST', key: PK, body: JSON.stringify({ access_code: d.access_code, card: card('4000000000000002') }) });
  check('insufficient funds -> failed', f.body?.data?.status === 'failed', f.body);

  // 4. Security checks
  const luhn = await checkout();
  const bad = await call('/v1/charge', { method: 'POST', key: PK, body: JSON.stringify({ access_code: luhn.access_code, card: card('4084084084084082') }) });
  check('Luhn-invalid card rejected', bad.status === 400, bad.body);
  const sk = await call('/v1/transaction', { key: PK });
  check('public key cannot list transactions', sk.status === 401, sk.body);
  const key = 'idem-fixed-' + Date.now();
  const k1 = await checkout(key);
  const k2 = await checkout(key);
  check('same Idempotency-Key -> same transaction', k1.reference === k2.reference, [k1, k2]);
  const forged = await call('/merchant/webhook', { method: 'POST', headers: { 'x-rahmpay-signature': 'deadbeef' }, body: JSON.stringify({ event: 'charge.success', data: { reference: luhn.reference, amount: 1 } }) });
  check('forged webhook rejected', forged.status === 401);

  await sleep(500);
  const t = await call(`/merchant/transactions/${b.reference}/timeline`, { token: TA });
  check('audit trail recorded', t.body?.map((e: any) => e.to_status).join('>') === 'initialized>pending>send_otp>success', t.body);

  const out = await call('/auth/logout', { method: 'POST', token: TA });
  const after = await call('/merchant/transactions', { token: TA });
  check('logout invalidates the token', out.status === 204 && after.status === 401, after.body);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
main();
