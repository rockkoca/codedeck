# Codedeck

An open-source remote command center for AI coding agents. Control Claude Code, Codex, Gemini CLI, OpenCode, and other agent CLIs from anywhere — your browser, your phone, on the train, at dinner — without SSH.

## Why Codedeck?

Your agents run locally in tmux on your machine — fully compliant, human-supervised, no API key tricks. Codedeck gives you a real-time remote interface to monitor, interact with, and manage them with a customizable UI purpose-built for coding workflows.

Chat platforms like Telegram and Discord are terrible for this: 4096-char message limits, no syntax highlighting, no diff views, no session management, rate-throttled bot APIs, and zero UI customizability. Codedeck replaces all of that with an interface you actually control.

## Features

- **Remote access from anywhere** — Web + mobile app with push notifications. No SSH, no VPN. Control your agents from any device, anytime.
- **Multiple view modes** — Switch between raw terminal (native agent CLI experience) and chat mode (structured conversation UI). Your choice.
- **Multi-server, multi-session** — Manage agents across multiple machines from a single dashboard. See all session statuses at a glance.
- **Real-time streaming** — Live terminal output, session state indicators, instant message delivery. No message length limits, no rate throttling.
- **Customizable & open source** — MIT licensed. The UI is fully yours to modify — syntax-highlighted diffs, collapsible sections, approval flows, whatever you need. Fork it, extend it, self-host it.
- **Cross-session communication** — Sessions can talk to each other. Run multi-agent workflows with real-time visibility into what each agent is doing.
- **Custom scripts** — User-defined scripts triggered by session events (agent idle, task complete, error detected).

## Architecture

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted or cloud)
        ↓ WebSocket
Daemon (your machine, manages tmux)
        ↓ tmux
AI Agents (Claude Code / Codex / Gemini CLI / OpenCode)
```

The daemon runs on your dev machine and manages agent sessions through tmux. The server relays WebSocket connections between your devices and the daemon. Everything stays under your control.

## Install

```bash
npm install -g @codedeck/codedeck
```

## Quick Start

```bash
# Bind this machine to your Codedeck server
codedeck bind https://your-server.com/bind/<api-key>

# Check status
codedeck status

# Or start the daemon manually
codedeck start
```

Once bound, the daemon starts automatically on login and your machine appears in the web UI.

## Requirements

- Node.js >= 20
- tmux
- One or more AI coding agents installed: [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [OpenCode](https://github.com/opencode-ai/opencode)

## Roadmap

- **GitHub & GitLab issue sync** — Pull issues directly, auto-generate implementation plans
- **Multi-agent workflows** — Agents discuss plans, implement, review each other's code, and push — with human approval gates
- **File upload & browsing** — Upload files to sessions, browse project files remotely
- **Remote web preview** — Preview dev server output directly from the UI without port forwarding
- **Diff & code review UI** — Inline diff viewer with approve/reject flows
- **Session templates** — Save multi-agent setups and replay them one-click
- **Cost tracking** — Per-session, per-project token usage dashboard
- **Session recording & replay** — Review past sessions for debugging or knowledge sharing
- **Persistent cross-session memory** — Project knowledge and architecture decisions survive across sessions

## License

MIT
# test
