import { readFile, writeFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline/promises';
import { loadConfig } from '../config.js';
import logger from '../util/logger.js';

const CREDS_DIR = join(homedir(), '.codedeck');
const CREDS_PATH = join(CREDS_DIR, 'server.json');

interface ServerCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
  serverName: string;
  boundAt: number;
}

export async function bindFlow(serverName: string): Promise<void> {
  const config = await loadConfig();
  const workerUrl = config.cf?.workerUrl;

  if (!workerUrl) {
    console.error('CF_WORKER_URL not set. Add it to ~/.codedeck/config.yaml or .env');
    process.exit(1);
  }

  const apiKey = config.cf?.apiKey;
  if (!apiKey) {
    console.error('CF_API_KEY not set.');
    process.exit(1);
  }

  // Step 1: Initiate bind — get a short code
  const initRes = await fetch(`${workerUrl}/api/bind/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ userId: 'me', serverName }),
  });

  if (!initRes.ok) {
    console.error(`Bind initiation failed: ${initRes.status}`);
    process.exit(1);
  }

  const { code, expiresAt } = await initRes.json() as { code: string; expiresAt: number };
  const expiresIn = Math.round((expiresAt - Date.now()) / 1000);
  console.log(`\nBind code: ${code}  (expires in ${expiresIn}s)\n`);
  console.log('Enter this code in your chat platform (/agent bind <code>) or press Enter to confirm here:');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('> ');
  rl.close();

  // Step 2: Confirm the bind
  const confirmRes = await fetch(`${workerUrl}/api/bind/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  if (!confirmRes.ok) {
    console.error(`Bind confirmation failed: ${confirmRes.status}`);
    process.exit(1);
  }

  const { serverId, token } = await confirmRes.json() as { serverId: string; token: string };

  // Step 3: Store credentials with 0600 permissions
  const creds: ServerCredentials = { serverId, token, workerUrl, serverName, boundAt: Date.now() };
  await mkdir(CREDS_DIR, { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });

  console.log(`\nBound successfully! Server ID: ${serverId}`);
  console.log(`Credentials saved to ${CREDS_PATH}`);
  logger.info({ serverId, serverName }, 'Daemon bound to CF server');
}

export async function loadCredentials(): Promise<ServerCredentials | null> {
  try {
    const raw = await readFile(CREDS_PATH, 'utf8');
    return JSON.parse(raw) as ServerCredentials;
  } catch {
    return null;
  }
}
