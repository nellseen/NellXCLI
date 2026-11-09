# AGENTS.md — NellXCLI Development Rules

These instructions apply to all work in this repository.

## 1. Mission

Build NellXCLI: an independent, cross-platform, Gemini-powered autonomous coding agent for the terminal. Aim for a polished Codex-like workflow while implementing our own architecture and code. Do not depend on Codex CLI internals, private APIs, or copied proprietary implementation code.

## 2. Fixed project decisions

- TypeScript and Node.js 22+
- pnpm
- Windows, macOS, and Linux support
- Google AI Studio / Gemini API as the initial provider
- Multi-account/project credential manager
- Persistent sessions and context continuity
- Interactive TUI and non-interactive CLI
- Unit, integration, and end-to-end testing

Do not change these decisions without asking the project owner.

## 3. Work process

Before changing code:
1. Inspect the repository and existing implementation.
2. Read relevant documentation and package scripts.
3. Identify affected modules and platform implications.
4. Write a short implementation plan for non-trivial changes.
5. Prefer small, reviewable changes over broad rewrites.

After changing code:
1. Run formatting and lint checks available in the repository.
2. Run TypeScript type checking.
3. Run relevant unit tests.
4. Run relevant integration and E2E tests when feasible.
5. Report exact commands and actual outcomes.
6. Document tests that could not be run and why.

Never fabricate test results, benchmark results, API behavior, or completed features.

## 4. Architecture boundaries

- Keep provider SDK details inside provider adapters.
- Keep the agent runtime provider-neutral.
- Keep credential management separate from sessions and conversation history.
- Keep tools behind a validated tool registry.
- Keep TUI rendering separate from agent orchestration.
- Keep persistence behind storage interfaces.
- Avoid circular dependencies.
- Use explicit types and Zod validation at external boundaries.

## 5. Account, project, and API-key rules

Treat these as different concepts:
- Account entry: user-managed profile/label for a Google AI Studio setup.
- Project: Google Cloud project associated with the Gemini API credentials.
- API key: secret credential belonging to a project.

An account may contain multiple API keys. Multiple account entries may point to the same project; detect and group these by project ID for quota tracking.

Do not infer or claim that a Google identity has been verified merely because a user typed an email or label.

Track health and cooldown at the appropriate project/model level, not only per API key. Rotating keys within one project must not be treated as a way to bypass project quota.

Failover is for reliability across legitimately configured projects/accounts. Never implement quota evasion, policy circumvention, billing bypass, or automated creation of accounts/projects.

## 6. Failover and context continuity

- Classify errors before retrying.
- Invalid credentials should be quarantined or marked for user action.
- Permission errors should be surfaced, not blindly retried.
- Rate limits and quota exhaustion require project/model-aware cooldown.
- Temporary server/network failures may use bounded exponential backoff with jitter.
- Invalid requests and policy/safety rejections must not be retried unchanged.
- Avoid unbounded retry loops.

Sessions must persist user instructions, conversation events, plans, tool calls/results, checkpoints, and pending work independently of provider credentials.

If a streaming request fails after partial output, do not blindly replay and duplicate visible text. Reconcile the partial response and request outcome before continuing.

Before replaying a tool operation, determine whether it already ran. Non-idempotent operations require special care.

## 7. Security requirements

- Never commit API keys, tokens, or real user secrets.
- Prefer OS credential stores where available.
- Provide an encrypted-vault fallback with a documented threat model.
- Never store plaintext secrets in ordinary settings files or logs.
- Redact credentials from errors, traces, telemetry, and test snapshots.
- Enforce workspace boundaries for file tools.
- Protect against path traversal and unsafe symlink escapes.
- Require approval for destructive or sensitive actions in Normal mode.
- Do not claim a true sandbox exists unless OS-level isolation is implemented and tested.
- Model-generated shell commands are untrusted input and must pass policy checks.

## 8. Coding standards

- Use strict TypeScript.
- Avoid `any`; explain exceptional use.
- Validate external input.
- Handle errors explicitly.
- Prefer small modules with single responsibilities.
- Add tests for bug fixes and new behavior.
- Keep cross-platform path and process behavior in mind.
- Do not silently swallow errors.
- Do not add dependencies without explaining why they are needed.

## 9. Definition of done

A task is done only when implementation, validation, tests, and documentation are complete for its scope. If a check cannot be run, say so explicitly. Do not mark an entire milestone complete based only on compiling or mocked tests.
