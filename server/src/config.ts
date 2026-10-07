import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (copy .env.example to .env)`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  gatewayUrl: process.env.GATEWAY_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  masterKey: Buffer.from(required('MASTER_KEY'), 'hex'),
  demoMerchant: {
    publicKey: required('DEMO_MERCHANT_PUBLIC_KEY'),
    secretKey: required('DEMO_MERCHANT_SECRET_KEY'),
    webhookSecret: required('DEMO_MERCHANT_WEBHOOK_SECRET'),
  },
  accessCodeTtlMinutes: 30,
  otpTtlMinutes: 5,
  otpMaxAttempts: 3,
  webhookMaxAttempts: 4,
};

if (config.masterKey.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (64 hex chars)');
