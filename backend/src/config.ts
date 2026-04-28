import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars (use: openssl rand -hex 32)'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  STORAGE_PROVIDER: z.enum(['lighthouse', 'mock']).default('mock'),
  LIGHTHOUSE_API_KEY: z.string().optional(),
  LIGHTHOUSE_WALLET_PRIVATE_KEY: z.string().optional(),
  IPFS_GATEWAY: z.string().url().default('https://gateway.lighthouse.storage/ipfs'),

  CORS_ORIGIN: z.string().default('*'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
