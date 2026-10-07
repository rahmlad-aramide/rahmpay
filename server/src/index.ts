import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { config } from './config';
import { migrate } from './db';
import { seedDemoMerchant } from './db/seed';
import { gateway } from './routes/gateway';
import { merchant } from './routes/merchant';
import { auth } from './routes/auth';
import { AppError } from './lib/errors';
import { TEST_CARDS, TEST_OTP } from './services/mockBank';

migrate();
seedDemoMerchant();

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors()); // mobile apps don't send Origin; lock this to known web origins in production
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(
  express.json({
    limit: '10kb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf.toString('utf8'); // needed to verify webhook signatures byte-for-byte
    },
  })
);

// Minimal request logger. Deliberately logs NO bodies or headers -> card data and keys never reach logs.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - start}ms`));
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/v1', gateway);
app.use('/auth', auth);
app.use('/merchant', merchant);

app.use((_req, res) => res.status(404).json({ status: false, message: 'Not found' }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ status: false, code: 'validation_error', message: err.issues[0]?.message ?? 'Invalid request', errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  if (err instanceof AppError) return res.status(err.status).json({ status: false, code: err.code, message: err.message });
  console.error(err);
  res.status(500).json({ status: false, code: 'internal_error', message: 'Something went wrong' }); // never leak stack traces
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`\nRahmPay running on http://localhost:${config.port}`);
  console.log('Test cards:');
  console.log(`  ${TEST_CARDS.SUCCESS}      -> success`);
  console.log(`  ${TEST_CARDS.OTP_REQUIRED}   -> OTP required (OTP: ${TEST_OTP})`);
  console.log(`  ${TEST_CARDS.INSUFFICIENT_FUNDS}      -> declined (insufficient funds)\n`);
});
