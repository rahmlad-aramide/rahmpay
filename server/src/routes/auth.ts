import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { db } from '../db';
import { credentialsSchema } from '../schemas';
import { newId, sha256 } from '../lib/crypto';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../lib/password';
import { AppError } from '../lib/errors';
import { requireUser } from '../middleware/user';

export const auth = Router();

const SESSION_DAYS = 30;

// Tight limit on credential endpoints: slows password guessing and mass sign-up
const authLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

function startSession(userId: string) {
  const token = `st_${crypto.randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()
  );
  return token;
}

auth.post('/register', authLimiter, async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new AppError(409, 'An account with this email already exists', 'email_taken');
  }
  const id = newId('USR');
  try {
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, await hashPassword(password));
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) throw new AppError(409, 'An account with this email already exists', 'email_taken');
    throw e;
  }
  res.status(201).json({ token: startSession(id), user: { id, email } });
});

auth.post('/login', authLimiter, async (req, res) => {
  const { email, password } = credentialsSchema.parse(req.body);
  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email) as
    | { id: string; email: string; password_hash: string }
    | undefined;
  // Same work and same message whether the email exists or not: no account enumeration via login
  const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
  if (!user || !ok) throw new AppError(401, 'Incorrect email or password', 'invalid_credentials');
  res.json({ token: startSession(user.id), user: { id: user.id, email: user.email } });
});

auth.get('/me', requireUser, (req, res) => res.json({ user: req.user }));

auth.post('/logout', requireUser, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
  res.sendStatus(204);
});
