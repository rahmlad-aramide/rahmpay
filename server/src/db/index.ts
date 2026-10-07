import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.join(process.cwd(), 'rahmpay.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // Databases created before accounts existed lack merchant_orders.user_id (CREATE TABLE IF NOT EXISTS won't add it)
  const cols = db.prepare('PRAGMA table_info(merchant_orders)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'user_id')) db.exec('ALTER TABLE merchant_orders ADD COLUMN user_id TEXT REFERENCES users(id)');
}
