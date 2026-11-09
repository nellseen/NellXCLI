# NellXCLI Feature Matrix

Status legend:

- [ ] Planned
- [~] Partially implemented
- [x] Implemented and tested

Statuses reflect current implementation and validation in the Codespaces workspace.

## Core

- [~] Non-interactive CLI (single task, session list/resume, and bounded stdin prompt)
- [x] Gemini streaming responses
- [~] Agent loop with iterative text-protocol tool calls and bounded steps
- [~] Cancellation signal handling
- [~] Ink chat, streaming output, tool activity, approvals, session list/resume, diff, modes, and cancellation (basic Linux PTY smoke verified (including idle Ctrl-C); cross-platform and full-flow TTY checks pending)

## Google AI Studio

- [x] Provider adapter, dynamic model discovery, capability metadata, error normalization
- [~] API smoke tests (opt-in; live API not verified)
- [ ] Native provider function calling

## Account manager

- [x] Multiple profiles and keys, project grouping, OS credential store and encrypted vault fallback
- [x] Project/model health and cooldown tracking
- [~] Cross-project failover (bounded retry and routing implemented; live quota behavior unverified)

## Context and sessions

- [x] SQLite event storage, checkpoints, session listing, session continuation
- [~] Interrupted operation reconciliation and partial output retention
- [x] Root-to-current-directory AGENTS.md discovery, nested AGENTS.md preflight before targeted and recursive file tools run, and hierarchical .gitignore-aware indexing
- [~] Persistent checkpoint compaction preserves user instructions, plans, recent tool results, and pending operations; bounded by character/event counts rather than model tokens

## Coding tools

- [x] Zod registry, file read/write, exact-text patch, list/search, git status/diff/log
- [~] Shell execution (allowlisted executable names, argv only, approval, timeout, output cap; user privileges)
- [~] Workspace traversal and symlink checks (race-resistant OS sandbox not provided)
- [~] Text working-tree diff viewer in Ink; no syntax coloring or staged/unstaged controls

## Advanced

- [~] Workspace skills with validated metadata and read-only tools (no global catalog/installer)
- [~] Approved Git worktree create/remove inside workspace boundaries
- [~] MCP stdio client (approval per launch/call, schema validation, bounded/redacted output; no remote transport or OAuth)
- [~] Read-only subagents (separate sessions, bounded steps/context, read-only tools; no independent OS sandbox)
- [~] Session-scoped background tasks (approved argv processes, durable status, timeout and cancellation; output discarded)
- [~] Workspace-bounded Gemini image attachments (CLI only; selected-model availability and live provider behavior unverified)

## Release hardening

- [~] CI workflow targets Node 22 on Linux/macOS/Windows (local verification only on Linux Codespaces)
- [~] Package install/uninstall smoke-tested on Linux only
- [x] Production dependency audit (no known vulnerabilities reported)
- [~] Security review and release checklist; cross-platform and credential-backed checks remain

This repository is not production-ready and does not provide Codex feature parity or an OS-level sandbox.
