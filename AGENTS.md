# AGENTS.md

This document defines how AI agents should behave and interact within the Codedeck project.

## Agent Roles
Codedeck is built to manage agents. When you are acting as an agent *on* this codebase:
- **Gemini CLI**: The primary orchestrator for codebase modifications, testing, and maintenance.
- **Claude Code / Codex / OpenCode**: These are the agents managed by the `daemon`. They operate in tmux sessions named `deck_{project}_{role}`.

## Guidelines
- **System Integrity**: Do not interfere with or modify active tmux sessions managed by the `daemon` unless explicitly instructed to debug them.
- **Project Context**: Respect the boundaries between `daemon` (`src/`), `server/`, `web/`, and `worker/`.
- **Implementation**: Follow the patterns and conventions established in `CLAUDE.md`.
- **i18n**: Use the established `i18next` pattern in the `web` project for all user-facing strings.
