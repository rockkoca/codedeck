export interface Env {
  // D1 database
  DB: D1Database;

  // Durable Objects
  DAEMON_BRIDGE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // Secrets (set via wrangler secret put)
  JWT_SIGNING_KEY: string;
  BOT_ENCRYPTION_KEY: string;  // AES-256 key for encrypting platform_bots.config_encrypted

  // Vars
  ENVIRONMENT: string;
  WORKER_URL: string;   // e.g. https://your-worker.workers.dev (used to build webhook URLs)
}
