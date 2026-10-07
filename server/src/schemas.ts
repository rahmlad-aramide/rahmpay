import { z } from 'zod';

export const initializeSchema = z.object({
  email: z.email(),
  amount: z.number().int().positive().max(100_000_000_00), // kobo; integers only
  currency: z.literal('NGN').default('NGN'),
  reference: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const chargeSchema = z.object({
  access_code: z.string().min(10).max(64),
  card: z.object({
    number: z.string().regex(/^\d{12,19}$/, 'Card number must be 12-19 digits'),
    cvv: z.string().regex(/^\d{3,4}$/, 'Invalid CVV'),
    expiry_month: z.string().regex(/^(0[1-9]|1[0-2])$/, 'Invalid expiry month'),
    expiry_year: z.string().regex(/^\d{2}(\d{2})?$/, 'Invalid expiry year'),
  }),
});

export const otpSchema = z.object({
  access_code: z.string().min(10).max(64),
  otp: z.string().regex(/^\d{4,8}$/),
});

export const credentialsSchema = z.object({
  email: z.email().max(254).transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export const checkoutSchema = z.object({
  items: z
    .array(z.object({ id: z.string(), qty: z.number().int().min(1).max(20) }))
    .min(1)
    .max(20),
});
