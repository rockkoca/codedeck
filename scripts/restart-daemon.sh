#!/bin/bash
# Rebuild and restart the local codedeck daemon (dev only).
# Usage: ./scripts/restart-daemon.sh

set -e
cd "$(dirname "$0")/.."

npm run build
npm link --force

codedeck service restart --no-build
