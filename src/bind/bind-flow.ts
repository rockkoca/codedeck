import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { execSync } from 'child_process';
import logger from '../util/logger.js';

const CREDS_DIR = join(homedir(), '.codedeck');
const CREDS_PATH = join(CREDS_DIR, 'server.json');
const PLIST_LABEL = 'cc.codedeck.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

interface ServerCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
  serverName: string;
  boundAt: number;
}

/**
 * Main entry point.
 * Usage: codedeck bind https://app.codedeck.cc/bind/<apiKey> [device-name]
 */
export async function bindFlow(bindUrl: string, deviceName?: string): Promise<void> {
  // Parse the bind URL
  let url: URL;
  try {
    url = new URL(bindUrl);
  } catch {
    console.error('Invalid URL. Usage: codedeck bind https://app.codedeck.cc/bind/<api-key> [device-name]');
    process.exit(1);
  }

  const pathParts = url.pathname.split('/').filter(Boolean); // ['bind', '<apiKey>']
  if (pathParts[0] !== 'bind' || !pathParts[1]) {
    console.error('Invalid bind URL format. Expected: https://<worker>/bind/<api-key>');
    process.exit(1);
  }

  const apiKey = pathParts[1];
  const workerUrl = url.origin;
  const serverName = deviceName ?? hostname();

  console.log(`Binding "${serverName}" to ${workerUrl}...`);

  // One-shot bind — no code dance needed
  const res = await fetch(`${workerUrl}/api/bind/direct`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ serverName }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Bind failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const { serverId, token } = await res.json() as { serverId: string; token: string };

  // Save credentials (0600 permissions)
  const creds: ServerCredentials = { serverId, token, workerUrl, serverName, boundAt: Date.now() };
  await mkdir(CREDS_DIR, { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  logger.info({ serverId, serverName }, 'Daemon bound');

  // Install tmux if missing
  await ensureTmux();

  // Install system service
  if (process.platform === 'darwin') {
    await installLaunchAgent();
    console.log('\nDaemon installed as a launch agent — starts automatically on login.');
  } else if (process.platform === 'linux') {
    await installSystemdService();
    console.log('\nDaemon installed as a systemd user service — starts automatically on login.');
  } else {
    console.log('\nRun "codedeck start" to start the daemon.');
  }

  console.log(`\nBound! Device "${serverName}" is ready.`);
  console.log(`Open ${workerUrl} to see it online.`);
}

async function ensureTmux(): Promise<void> {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return; // already installed
  } catch {
    // not found
  }

  if (process.platform === 'darwin') {
    // Check brew is available
    try {
      execSync('which brew', { stdio: 'ignore' });
    } catch {
      console.error('tmux not found and Homebrew is not installed. Please install tmux manually: https://formulae.brew.sh/formula/tmux');
      process.exit(1);
    }
    console.log('tmux not found — installing via Homebrew...');
    execSync('brew install tmux', { stdio: 'inherit' });
    console.log('tmux installed.');
  } else {
    console.error('tmux not found. Please install it with your package manager (e.g. apt install tmux).');
    process.exit(1);
  }
}

async function installLaunchAgent(): Promise<void> {
  const nodeExec = process.execPath;
  const script = process.argv[1];
  const logPath = join(CREDS_DIR, 'daemon.log');
  const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${script}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;

  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(PLIST_PATH, plist, 'utf8');

  // Unload existing (ignore error), then load fresh
  try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' }); } catch { /* ok */ }
  execSync(`launchctl load -w "${PLIST_PATH}"`);
  console.log(`Launch agent loaded: ${PLIST_PATH}`);
}

async function installSystemdService(): Promise<void> {
  const nodeExec = process.execPath;
  const script = process.argv[1];
  const logPath = join(CREDS_DIR, 'daemon.log');
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  const servicePath = join(serviceDir, 'codedeck.service');

  const unit = `[Unit]
Description=Codedeck Daemon
After=network.target

[Service]
ExecStart=${nodeExec} ${script} start
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=HOME=${homedir()}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

  await mkdir(serviceDir, { recursive: true });
  await writeFile(servicePath, unit, 'utf8');

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync('systemctl --user enable --now codedeck', { stdio: 'inherit' });
  console.log(`Systemd user service installed: ${servicePath}`);
}

export async function loadCredentials(): Promise<ServerCredentials | null> {
  try {
    const raw = await readFile(CREDS_PATH, 'utf8');
    return JSON.parse(raw) as ServerCredentials;
  } catch {
    return null;
  }
}
