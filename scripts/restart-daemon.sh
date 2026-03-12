#!/bin/bash
# Rebuild and restart the local codedeck daemon.
# Usage: ./scripts/restart-daemon.sh

set -e

cd "$(dirname "$0")/.."

echo "==> Building..."
npm run build

echo "==> Linking globally..."
npm link

echo "==> Stopping daemon..."
codedeck stop 2>/dev/null || true
sleep 1

# Kill any lingering daemon processes
pgrep -f 'node.*codedeck start' | xargs -r kill 2>/dev/null || true
sleep 1

echo "==> Starting daemon..."
codedeck start &
disown

sleep 2
echo "==> Done. Daemon PID:"
pgrep -f 'node.*codedeck start' || echo "(not found)"
