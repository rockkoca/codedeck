#!/bin/bash
# Rebuild and restart the local codedeck daemon.
# Usage: ./scripts/restart-daemon.sh

set -e
cd "$(dirname "$0")/.."

npm run build
npm link

codedeck service restart
