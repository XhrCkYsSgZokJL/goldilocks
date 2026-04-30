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

  // SIWE auth — domain + URI baked into challenge messages so signatures
  // can't be replayed against a different deployment.
  SIWE_DOMAIN: z.string().default('local.goldilocksdigital.xyz'),
  SIWE_URI: z.string().url().default('http://localhost:4000/api/v2/me'),

  // XMTP node gRPC — used to verify a caller's eth address is bound to
  // the inbox they claim. Defaults match `dev/up`.
  XMTP_GRPC_URL: z.string().default('localhost:5556'),
  XMTP_GRPC_SECURE: z.coerce.boolean().default(false),

  // XMTP network the server-side agents (admins-agent, reports-agent)
  // connect to. Must match the network the iOS app is on. 'local' points
  // at the convos-ios `./dev/up` node.
  XMTP_NETWORK: z.enum(['local', 'dev', 'production']).default('local'),
  // Custom XMTP API URL for 'local' network. Ignored on dev/production.
  // The convos-ios local node serves gRPC on 5556 (h2c) — the iOS client
  // hits the same port.
  XMTP_API_URL: z.string().default('http://localhost:5556'),

  // Where each agent stores its local SQLCipher DB. One file per agent
  // (admins.db3, reports.db3). Defaults to ./.agent-data relative to the
  // CWD so local dev works without editing .env. Override to an absolute
  // path (e.g. /var/lib/goldilocks-agent inside docker) for prod.
  AGENT_DB_DIR: z.string().default('./.agent-data'),

  // 32-byte hex (without 0x prefix is fine) used to encrypt the agent's
  // local XMTP DB. Generate with: openssl rand -hex 32
  AGENT_DB_ENCRYPTION_KEY: z.string().default(''),

  // DEV-ONLY: when true, /v2/admin/promote-self is enabled. NEVER set this
  // in production — anyone with a JWT could grant themselves admin.
  GOLDILOCKS_ALLOW_SELF_PROMOTE: z.coerce.boolean().default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
