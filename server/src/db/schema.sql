-- RahmPay schema. All money is stored as INTEGER minor units (kobo) - never floats.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS merchants (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  public_key              TEXT NOT NULL UNIQUE,
  secret_key_hash         TEXT NOT NULL UNIQUE,      -- SHA-256 of the secret key; plaintext never stored
  webhook_url             TEXT,
  webhook_secret_enc      TEXT NOT NULL,             -- AES-256-GCM encrypted (needed in plaintext to sign)
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Card vault: tokens only. PAN and CVV are NEVER persisted.
CREATE TABLE IF NOT EXISTS card_tokens (
  id            TEXT PRIMARY KEY,                    -- authorization code, e.g. AUTH_xxx
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  fingerprint   TEXT NOT NULL,                       -- HMAC-SHA256(PAN) - lets us recognise a card without storing it
  last4         TEXT NOT NULL,
  bin           TEXT NOT NULL,                       -- first 6 digits (allowed under PCI DSS)
  brand         TEXT NOT NULL,
  exp_month     TEXT NOT NULL,
  exp_year      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_card_tokens_fp ON card_tokens(merchant_id, fingerprint);

CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  reference         TEXT NOT NULL UNIQUE,
  access_code       TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  idempotency_key   TEXT,
  amount_kobo       INTEGER NOT NULL CHECK (amount_kobo > 0),
  currency          TEXT NOT NULL DEFAULT 'NGN',
  email             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('initialized','pending','send_otp','success','failed','abandoned')),
  channel           TEXT,
  card_token_id     TEXT REFERENCES card_tokens(id),
  gateway_response  TEXT,
  metadata          TEXT,                            -- JSON
  paid_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_id, created_at);

-- Append-only audit trail of every state change
CREATE TABLE IF NOT EXISTS transaction_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  transaction_id  TEXT PRIMARY KEY REFERENCES transactions(id),
  otp_hash        TEXT NOT NULL,                     -- HMAC of the OTP, never the OTP itself
  expires_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id    TEXT NOT NULL REFERENCES transactions(id),
  event             TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_status_code  INTEGER,
  delivered         INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Demo MERCHANT's customer accounts (live in the merchant's database, not the gateway's) ----
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,               -- stored lowercase
  password_hash  TEXT NOT NULL,                      -- scrypt: salt.hash (never the password)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                      -- SHA-256 of the bearer token; plaintext never stored
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---- Demo MERCHANT's own table (conceptually lives in the merchant's database, not the gateway's) ----
CREATE TABLE IF NOT EXISTS merchant_orders (
  reference     TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  user_id       TEXT REFERENCES users(id),           -- owner of the order; NULL only for pre-accounts rows
  items         TEXT NOT NULL,                       -- JSON
  amount_kobo   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','paid','failed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
