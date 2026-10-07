import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';

export type Merchant = {
  id: string;
  name: string;
  public_key: string;
  webhook_url: string | null;
  webhook_secret_enc: string;
};

declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
    }
  }
}

function bearer(req: Request) {
  const h = req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Server-to-server calls (initialize, verify, list). Secret key is looked up by its hash. */
export function requireSecretKey(req: Request, _res: Response, next: NextFunction) {
  const key = bearer(req);
  if (!key.startsWith('sk_')) throw new AppError(401, 'Invalid or missing secret key', 'unauthorized');
  const merchant = db
    .prepare('SELECT id, name, public_key, webhook_url, webhook_secret_enc FROM merchants WHERE secret_key_hash = ?')
    .get(sha256(key)) as Merchant | undefined;
  if (!merchant) throw new AppError(401, 'Invalid or missing secret key', 'unauthorized');
  req.merchant = merchant;
  next();
}

/** Client-side calls from the mobile app. Public keys can only touch a transaction via its access code. */
export function requirePublicKey(req: Request, _res: Response, next: NextFunction) {
  const key = bearer(req);
  if (key.startsWith('sk_')) throw new AppError(403, 'Never use a secret key in a client app', 'forbidden');
  const merchant = db
    .prepare('SELECT id, name, public_key, webhook_url, webhook_secret_enc FROM merchants WHERE public_key = ?')
    .get(key) as Merchant | undefined;
  if (!merchant) throw new AppError(401, 'Invalid or missing public key', 'unauthorized');
  req.merchant = merchant;
  next();
}
