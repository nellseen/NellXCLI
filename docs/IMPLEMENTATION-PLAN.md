# NellXCLI — Implementation Roadmap

Build in vertical slices. Each milestone must compile, have tests, and leave the main branch usable.

## Milestone 0 — Repository foundation

Deliver:
- pnpm workspace/package setup
- strict TypeScript configuration
- lint and format scripts
- Vitest setup
- CLI entry point `nellx`
- structured logging
- config directory resolution for Windows/macOS/Linux
- CI workflow for all three operating systems
- initial documentation

Acceptance:
- clean install
- build succeeds
- typecheck succeeds
- lint succeeds
- unit test command succeeds
- CLI prints version and help

## Milestone 1 — Gemini provider

Deliver:
- provider-neutral interface
- Google AI Studio adapter using `@google/genai`
- secure API key input/configuration
- dynamic model discovery
- capability-aware model selection
- streaming text response
- normalized provider errors
- mocked provider tests and opt-in real API smoke test

Acceptance:
- no secrets printed or logged
- unavailable models are not offered as usable
- model and credential errors are actionable
- tests cover streaming and error normalization

## Milestone 2 — Account/project manager

Deliver:
- account profile CRUD
- multiple API keys per profile
- project grouping
- credential references
- OS credential-store integration where supported
- encrypted-vault fallback
- health and cooldown persistence
- account selection UI/commands

Acceptance:
- raw secrets never appear in SQLite/settings/logs
- duplicate project IDs are grouped for quota tracking
- key rotation within the same project does not reset project health
- user can disable/remove a profile safely

## Milestone 3 — Failover and context continuity

Deliver:
- error classifier
- project/model-aware cooldown
- bounded exponential backoff with jitter
- account/project selection policy
- failover event persistence
- session checkpointing
- uncertain-request reconciliation
- resume after provider failure

Acceptance:
- simulated project A quota failure selects eligible project B
- same-project alternate key does not falsely clear project quota
- session instructions, plan, and completed tool results survive failover
- partial streaming output is not duplicated
- no infinite retry loop

## Milestone 4 — Coding tools and agent loop

Deliver:
- tool registry with Zod schemas
- read/list/search files
- write and patch files
- shell execution with approval and timeout
- iterative agent loop
- plan/task state
- workspace boundary enforcement
- diff generation

Acceptance:
- model can request multiple sequential tool calls
- tool results are persisted
- invalid tool input is rejected
- path traversal is blocked
- destructive actions require approval in Normal mode

## Milestone 5 — Sessions and TUI

Deliver:
- Ink terminal interface
- interactive prompt
- streaming display
- tool activity display
- approval UI
- session list/resume
- slash commands
- diff viewer
- cancellation

Acceptance:
- interactive CLI works in supported terminals on Windows/macOS/Linux
- non-interactive mode works in CI/pipelines
- interrupted session can be resumed safely

## Milestone 6 — Codex-like workflow

Deliver:
- AGENTS.md discovery and precedence rules
- context engine and ignore rules
- Git status/diff/log
- Plan mode
- Auto mode with workspace restrictions
- context compaction
- robust error recovery

Acceptance:
- nested instructions are applied predictably
- ignored files are not accidentally indexed
- compaction preserves user requirements and pending work

## Milestone 7 — Advanced features

Deliver incrementally:
- MCP client
- skills
- subagents
- Git worktree support
- background tasks
- image input where supported

Each feature requires a design note, threat analysis, tests, and docs.

## Milestone 8 — Release hardening

Deliver:
- cross-platform CI
- packaging and npm publishing configuration
- install/uninstall tests
- security review
- dependency audit
- user documentation
- release checklist

Do not claim full Codex feature parity. Maintain a feature matrix that distinguishes implemented, partial, planned, and unsupported features.
