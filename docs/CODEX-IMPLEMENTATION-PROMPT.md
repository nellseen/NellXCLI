# Master Prompt for Codex CLI — Build NellXCLI

You are the senior engineer implementing NellXCLI in this repository.

First read:
- `AGENTS.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION-PLAN.md`
- `docs/TESTING.md`
- `docs/SECURITY.md`

## Your task

Inspect the current repository, then implement **Milestone 0 only** from `docs/IMPLEMENTATION-PLAN.md`.

Do not jump ahead and generate the entire product in one pass. Establish a reliable foundation first.

## Requirements

- TypeScript, Node.js 22+, pnpm.
- Cross-platform Windows/macOS/Linux.
- Strict TypeScript.
- CLI executable named `nellx`.
- Scripts for build, lint, typecheck, test, and formatting.
- Vitest configured.
- Structured logging with secret redaction conventions.
- CI workflow for Windows, macOS, and Linux.
- Documentation for local development.

## Engineering rules

- Inspect before editing.
- Explain the plan briefly.
- Use current stable, mutually compatible dependencies and verify their APIs.
- Avoid unnecessary dependencies.
- Do not implement fake provider functionality.
- Do not commit secrets.
- Do not claim tests passed unless you ran them.
- Keep changes scoped to Milestone 0.
- If the repository already contains work, preserve it and adapt rather than overwriting blindly.

## Completion report

At the end, report:
1. Files created/changed.
2. Architecture decisions.
3. Commands executed.
4. Actual test/build results.
5. Known issues or skipped checks.
6. Exact next step for Milestone 1.

Stop after Milestone 0. Wait for review before proceeding.
