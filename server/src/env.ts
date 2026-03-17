import type { PgDatabase } from './db/client.js';

/** Environment config loaded from process.env (no DB, that's injected at runtime). */
export interface EnvConfig {
  // Database connection string
  DATABASE_URL: string;

  // Secrets
  JWT_SIGNING_KEY: string;
  BOT_ENCRYPTION_KEY: string;

  // GitHub OAuth (optional — disables GitHub login if absent)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  // Server URL (used to build webhook URLs)
  SERVER_URL: string;

  // Security
  /** Comma-separated allowed origins for browser WebSocket connections.
   * Required in production. If unset and NODE_ENV=development, all origins are allowed.
   * Example: https://codedeck.example.com */
  ALLOWED_ORIGINS?: string;

  /** Comma-separated trusted proxy CIDRs for X-Forwarded-For IP extraction.
   * Example: 10.0.0.0/8,172.16.0.0/12 */
  TRUSTED_PROXIES?: string;

  /** Header name that carries the real client IP injected by the CDN/proxy.
   * Default: cf-connecting-ip (Cloudflare). Use x-real-ip or similar for other CDNs. */
  REAL_IP_HEADER?: string;

  /** Header name that carries the original client-facing hostname set by an upstream proxy.
   * Default: x-original-host. Cloudflare overwrites X-Forwarded-Host, so a separate
   * header (set by e.g. Caddy) is needed to preserve the real domain. */
  ORIGINAL_HOST_HEADER?: string;

  /** Fixed WebAuthn rpId to use for all passkey operations.
   * Must be a registrable domain suffix of every origin that will use passkeys.
   * Example: set to "codedeck.org" so both app.codedeck.org and hk.codedeck.org share passkeys.
   * If unset, rpId is derived from the request host. */
  WEBAUTHN_RP_ID?: string;

  // Network
  /** Host to bind the HTTP server on. Default: 0.0.0.0 (logs a warning). */
  BIND_HOST?: string;
  /** Port to listen on. Default: 3000 */
  PORT?: string;

  // Runtime
  NODE_ENV?: string;
  ENVIRONMENT?: string;
}

/** Full Env type used in Hono context — includes the injected PgDatabase instance. */
export interface Env extends EnvConfig {
  /** Injected at app startup via createDatabase(). */
  DB: PgDatabase;
}

/** Parse and validate env from process.env. Exits on missing required vars. */
export function loadEnv(): EnvConfig {
  const required = ['DATABASE_URL', 'JWT_SIGNING_KEY', 'BOT_ENCRYPTION_KEY'] as const;
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`[startup] Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    JWT_SIGNING_KEY: process.env.JWT_SIGNING_KEY!,
    BOT_ENCRYPTION_KEY: process.env.BOT_ENCRYPTION_KEY!,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    SERVER_URL: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
    REAL_IP_HEADER: process.env.REAL_IP_HEADER,
    ORIGINAL_HOST_HEADER: process.env.ORIGINAL_HOST_HEADER,
    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    BIND_HOST: process.env.BIND_HOST,
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };
}
