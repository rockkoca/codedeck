import type { DaemonBridge } from '../durable-objects/DaemonBridge.js';
import type { RateLimiter } from '../durable-objects/RateLimiter.js';

export interface Env {
  // D1 database
  DB: D1Database;

  // Durable Objects
  DAEMON_BRIDGE: DurableObjectNamespace<DaemonBridge>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // Secrets (set via wrangler secret put)
  JWT_SIGNING_KEY: string;

  // Vars
  ENVIRONMENT: string;
  WORKER_URL: string;   // e.g. https://your-worker.workers.dev (used to build webhook URLs)
}
