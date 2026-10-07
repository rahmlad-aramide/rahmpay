import { db } from './index';
import { config } from '../config';
import { encrypt, sha256, newId } from '../lib/crypto';

export function seedDemoMerchant() {
  const { publicKey, secretKey, webhookSecret } = config.demoMerchant;
  const exists = db.prepare('SELECT id FROM merchants WHERE public_key = ?').get(publicKey);
  if (exists) return;
  db.prepare(
    `INSERT INTO merchants (id, name, public_key, secret_key_hash, webhook_url, webhook_secret_enc)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    newId('MER'),
    'Rahmlad Store',
    publicKey,
    sha256(secretKey),
    `${config.gatewayUrl}/merchant/webhook`,
    encrypt(webhookSecret)
  );
  console.log('Seeded demo merchant "Rahmlad Store"');
}
