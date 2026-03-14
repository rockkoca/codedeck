# codedeck

Remote control AI coding agents (Claude Code, Codex, OpenCode) via Discord, Telegram, Feishu, web terminal, and native mobile apps.

## Install

```bash
npm install -g @codedeck/codedeck
```

## Quick Start

```bash
# Start the daemon
codedeck start

# Bind to Cloudflare central server
codedeck bind

# Check status
codedeck status

# Send a message to an agent session
codedeck send --session deck_myapp_w1 "fix the auth bug"

# Run auto-fix with two agents
codedeck autofix --project myapp "fix the authentication timeout bug"
```

## Requirements

- Node.js >= 20
- tmux
- One or more AI agents: Claude Code, Codex, or OpenCode

## Documentation

See [design.md](openspec/changes/codedeck/design.md) for architecture decisions.
