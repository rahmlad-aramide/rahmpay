# RahmPay

RahmPay is a Paystack-style payment gateway demo. A React Native storefront app pays through a gateway API that talks to a mock bank.

The core design principle: **the app is never trusted.** It sends no prices, holds no secret key, and its claim of success is ignored. The merchant always verifies a payment with the gateway.

Customers sign in with an email and password. Each customer sees only their own orders and transactions.

## Repository layout

| Folder | What it is |
| --- | --- |
| `server/` | Node/Express backend: the gateway API (`/v1`), a mock issuing bank, and a demo merchant backend (`/merchant`, "Rahmlad Store") |
| `rahmpay/` | Expo / React Native storefront app: product list, checkout, OTP, result and transaction history |

## Tech stack

| Layer | Choice |
| --- | --- |
| App | Expo SDK 57, React Native 0.86, Expo Router, TypeScript (strict) |
| Server | Node (>= 18.18), Express 5, TypeScript (run with `tsx`) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Validation | `zod` |
| Hardening | `helmet`, `express-rate-limit`, `cors` |
| Accounts | Email and password, hashed with Node's built-in `scrypt`; opaque session tokens |
| Token storage (app) | `expo-secure-store` (iOS Keychain / Android Keystore) |
| Money | Integer kobo everywhere; converted to naira only for display |

## How a payment works

0. The customer signs in (`POST /auth/login`, or `/auth/register` the first time) and gets a session token. Every merchant call below carries it.
1. The app sends **product IDs and quantities** to `POST /merchant/checkout`. The merchant server prices the order from its own catalog and ties it to the signed-in customer.
2. The merchant calls the gateway's `POST /v1/transaction/initialize` with its **secret key** and gets a `reference` and an `access_code` (valid 30 minutes).
3. The app sends the card and the access code **straight to the gateway** (`POST /v1/charge`, public key). The merchant never sees card data.
4. The mock bank decides the outcome: approved, OTP required, or declined. For OTP the app calls `POST /v1/charge/submit_otp`.
5. The gateway records the result and sends a **signed webhook** to the merchant.
6. The app calls `POST /merchant/orders/:reference/confirm`. The merchant re-verifies with the gateway (status, amount, currency) before marking the order paid.

## Running it

### Prerequisites

- Node.js 18.18 or newer
- The Expo Go app on a phone, or an iOS simulator / Android emulator
- For a real phone: the phone and the computer on the same Wi-Fi network

### 1. Start the server

```bash
cd server
npm install
cp .env.example .env
```

Edit `.env` and set real values. Generate the master key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then start it:

```bash
npm run dev
```

The server listens on `0.0.0.0:4000`, creates `rahmpay.db` on first boot, and seeds the demo merchant "Rahmlad Store". Check it with `curl localhost:4000/health`.

Required environment variables: `MASTER_KEY` (64 hex characters), `DEMO_MERCHANT_PUBLIC_KEY`, `DEMO_MERCHANT_SECRET_KEY`, `DEMO_MERCHANT_WEBHOOK_SECRET`. Optional: `PORT` (default 4000) and `GATEWAY_URL`.

### 2. Start the app

```bash
cd rahmpay
npm install
npx expo start
```

Scan the QR code with Expo Go. On a real phone the app finds the server automatically through Metro's LAN address. To override it, set `EXPO_PUBLIC_API_URL` in `rahmpay/.env`:

| Where the app runs | Value |
| --- | --- |
| Real phone | Leave it unset |
| Android emulator | `http://10.0.2.2:4000` |
| iOS simulator | `http://localhost:4000` |

Expo reads `.env` only at startup, so restart with `npx expo start -c` after changing it.

If the app shows "Can't reach the server", check that both devices share a Wi-Fi network and that the computer's firewall allows port 4000.

### 3. Try a payment

Create an account on the first screen (password of at least 8 characters), or sign in. Then add items with **+**, tap **Pay**, then pick a test card chip on the checkout screen:

| Card number | Outcome |
| --- | --- |
| `4084084084084081` | Approved |
| `5399838383838381` | Approved (Mastercard) |
| `5060666666666666666` | OTP required, enter `123456` |
| `4000000000000002` | Declined: insufficient funds |

Any other card number is declined in test mode. Use any future expiry and any 3-digit CVV.

### Tests and checks

```bash
# server (with `npm run dev` running in another terminal)
cd server
npm run test:e2e     # end-to-end run: accounts, ownership, payment flow, security checks
npm run typecheck

# app
cd rahmpay
npx tsc --noEmit
npx expo lint
```

## Security design

- **Two key types.** Secret keys (`sk_...`) are server-only, and the server stores only their SHA-256 hash. Public keys can act on a transaction only together with its access code. A secret key sent from a client is rejected with `403`.
- **Customer accounts.** Passwords are hashed with `scrypt` and a per-user random salt, never stored in plain text. Login returns a random session token; the server stores only its SHA-256 hash, so a database leak does not expose usable tokens. Sessions last 30 days and logout revokes them immediately.
- **Per-customer access control.** `/merchant/checkout`, `/merchant/config`, order confirmation, the transaction list and the timeline all require sign-in. A customer who asks for someone else's order gets `404`, and the transaction list contains only their own orders. The receipt email comes from the account, not from the request.
- **Login hardening.** Login and register are limited to 10 requests per minute. A wrong password and an unknown email produce the same error and take the same time, so login can't be used to discover which emails have accounts.
- **Token storage on the device.** The session token is kept in the Keychain / Keystore through `expo-secure-store`. An expired or revoked session sends the user back to the login screen.
- **No card data at rest.** The PAN and CVV are never stored. The `card_tokens` table keeps only the last 4 digits, the BIN, brand, expiry, and an HMAC fingerprint of the card number.
- **Server-side pricing.** The app sends product IDs and quantities, never prices. Amounts are integer kobo.
- **Idempotency.** Each checkout attempt carries an `Idempotency-Key`. A retry or double tap returns the same transaction, and reusing a key with a different payload returns `409`.
- **State machine.** Only legal transitions are allowed (for example `initialized` to `pending` to `success` or `failed`). An `UPDATE ... WHERE status = ?` guard inside a database transaction stops concurrent charges.
- **OTP handling.** OTPs are stored as an HMAC, expire after 5 minutes, and allow 3 attempts.
- **Signed webhooks.** HMAC-SHA512 over the raw request body, verified with a constant-time comparison, retried with exponential backoff. The webhook secret is encrypted at rest with AES-256-GCM.
- **Rate limiting.** 120 requests per minute overall and 20 per minute on the card endpoints.
- **Hygiene.** `helmet`, a 10 kb body limit, request logs that never contain bodies or headers, generic 500 responses with no stack traces, and IDs from `crypto.randomBytes`.
- **Audit trail.** `transaction_events` records every state change.
- **Verification, not trust.** The merchant confirms every payment with the gateway using its secret key instead of believing the app or a webhook alone.
- **App.** Card input is validated on the device (Luhn, expiry, length), the CVV field is masked, and requests time out after 8 seconds.

## Current limitations

This is a demo, not a production payment system.

- **Plain HTTP.** The app and server talk over HTTP. Production needs TLS only.
- **Basic account system.** There is no email verification, password reset, or account lockout after repeated failures (only the per-IP rate limit). Registration reveals whether an email is already taken. Sessions are bearer tokens with no device binding or refresh flow.
- **History is capped.** The transaction list shows a customer's 20 most recent orders.
- **Open CORS.** `cors()` accepts any origin. It should be limited to known origins.
- **Mock bank.** Outcomes depend on test card numbers. A real system needs a processor or acquirer integration.
- **In-memory webhook retries.** Retries use `setTimeout` and are lost if the server restarts. Production needs a durable queue.
- **SQLite, single process.** There is no migrations tool and it does not scale horizontally.
- **PCI DSS scope.** Collecting card numbers in your own app brings heavy compliance scope. A hosted card form or the provider's SDK is safer.
- **Demo conveniences.** The test cards and the OTP are printed at server startup and shown in the app. Remove them from any real build.
- **Limited tests.** The only automated test is the server's end-to-end script. The app has none.
