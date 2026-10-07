import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';

export type User = { id: string; email: string };

declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionTokenHash?: string;
    }
  }
}

/** Customer (end-user) auth for the merchant routes. Not related to the merchant's gateway keys. */
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith('st_')) throw new AppError(401, 'Please sign in', 'unauthorized');
  const hash = sha256(token);
  const row = db
    .prepare('SELECT u.id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(hash) as { id: string; email: string; expires_at: string } | undefined;
  if (!row) throw new AppError(401, 'Please sign in', 'unauthorized');
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    throw new AppError(401, 'Session expired, please sign in again', 'unauthorized');
  }
  req.user = { id: row.id, email: row.email };
  req.sessionTokenHash = hash;
  next();
}
