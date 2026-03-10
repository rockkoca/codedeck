# remote-chat-cli

Remote control AI coding agents (Claude Code, Codex, OpenCode) via Discord, Telegram, Feishu, web terminal, and native mobile apps.

## Install

```bash
npm install -g remote-chat-cli
```

## Quick Start

```bash
# Start the daemon
chat-cli start

# Bind to Cloudflare central server
chat-cli bind

# Check status
chat-cli status

# Send a message to an agent session
chat-cli send --session rcc_myapp_w1 "fix the auth bug"

# Run auto-fix with two agents
chat-cli autofix --project myapp "fix the authentication timeout bug"
```

## Requirements

- Node.js >= 20
- tmux
- One or more AI agents: Claude Code, Codex, or OpenCode

## Documentation

See [design.md](openspec/changes/remote-chat-cli/design.md) for architecture decisions.
