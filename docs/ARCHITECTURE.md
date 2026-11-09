# NellXCLI — Technical Architecture

## 1. Product vision

NellXCLI is an independent cross-platform terminal coding agent inspired by Codex CLI's user workflow. It should understand codebases, plan multi-step work, edit files, run commands, inspect diffs, test changes, and resume interrupted sessions.

The product must implement its own agent runtime. Do not depend on Codex CLI internals or copy proprietary implementation code.

## 2. Initial technology choices

- TypeScript
- Node.js 22+
- pnpm
- Commander for CLI parsing
- Ink + React for interactive terminal UI
- `@google/genai` for Gemini API access
- Zod for runtime validation
- Vitest for tests
- execa for process execution
- Pino for structured logging
- simple-git for Git operations
- SQLite for structured local persistence
- tsup for packaging/building

Verify current SDK APIs and supported Node versions against official documentation during implementation. Pin compatible dependency versions.

## 3. High-level layers

### CLI layer

Argument parsing, commands, interactive mode, non-interactive mode, configuration, and exit codes.

### TUI layer

Streaming messages, input, tool activity, approval prompts, diff display, session navigation, and status indicators.

### Agent runtime

Provider-neutral agent loop, planning, tool orchestration, context selection, task completion, cancellation, and recovery.

### Provider adapters

A normalized interface for model discovery, streaming, function calling, token usage, cancellation, and provider error classification. Initial adapter: Google AI Studio / Gemini.

### Tool runtime

Validated tools for reading/writing files, patching, searching, listing, shell execution, and Git inspection.

### Storage

Transactional persistence for settings, account metadata, sessions, event history, plans, tool operations, checkpoints, and usage metadata.

## 4. Agent loop

The agent loop must:

1. Receive the user's task and current session state.
2. Build a bounded context from instructions, relevant files, history, and plan.
3. Request a model response.
4. Stream user-visible output safely.
5. Validate any requested tool calls.
6. Apply permission checks.
7. Execute approved tools.
8. Persist tool calls and results.
9. Feed results back to the model.
10. Continue until completion, cancellation, or a bounded error condition.

Do not assume one model response completes a task. Include iteration limits, cancellation, and loop detection.

Workspace `AGENTS.md` files apply from the workspace root through a target directory. Before a file tool runs, NellXCLI loads the applicable instructions; recursive listing and search also preload descendant instructions to the tool's depth. When new instructions are found, the tool call is deferred so the model can review them first. Discovery is bounded to 100 KB and 1,000 directories, skips protected internal trees and symlinked directories, and verifies real paths remain inside the workspace.

## 5. Provider interface

Define a provider-neutral interface for:

- listModels
- generate/stream response
- tool/function calling
- usage metadata
- cancellation
- normalized errors

Do not leak Gemini SDK types into the core runtime. Model discovery must reflect models actually available to the configured credential/project and must not assume every listed model supports every feature.

## 6. Account/project/API-key model

These are distinct entities:

- Account profile: a user-managed label for an AI Studio setup. An email/label is not proof of verified Google identity.
- Project: the Google Cloud project associated with Gemini API credentials.
- API key: a secret credential associated with a project.

An account profile can contain multiple API keys. Multiple profiles can point to the same project. The system must group credentials by project for quota and health tracking.

Suggested entities:

### AccountProfile

- id
- displayName
- optional userLabel
- projectId
- enabled
- priority
- createdAt
- updatedAt

### ApiCredential

- id
- accountProfileId
- projectId
- secretReference
- enabled
- status
- createdAt
- lastUsedAt

### ProjectHealth

- projectId
- model
- status
- cooldownUntil
- lastErrorCategory
- lastSuccessAt
- updatedAt

Never persist raw API keys in SQLite or ordinary JSON settings. Store a credential reference to an OS keychain/credential store or encrypted vault.

## 7. Failover behavior

1. Resolve the requested model and required capabilities.
2. Find enabled profiles and credentials.
3. Group candidates by project.
4. Exclude projects in cooldown or known to lack required capability.
5. Select an eligible project using priority/health policy.
6. Execute request.
7. Normalize and classify errors.
8. Apply credential quarantine, project/model cooldown, or bounded retry as appropriate.
9. Select another eligible project only when appropriate.
10. Resume the same logical agent session.

Error categories:

- authentication
- permission
- rate_limit
- quota_exhausted
- temporary_server
- network
- invalid_request
- safety_or_policy
- unknown

Do not treat every 429 as proof that switching keys helps. Distinguish project/model quota conditions where provider response details allow it. Never rotate credentials to evade provider enforcement or billing restrictions.

## 8. Context and session persistence

Use an event-based session model. Persist:

- user and assistant messages
- tool call requests
- tool execution start/result/failure
- approvals
- plans and plan updates
- provider failover events
- checkpoints
- task completion/cancellation

Context compaction must preserve system/developer instructions, user requirements, important decisions, unfinished work, and references to source events.

Provider credential changes must not reset conversation history or task state.

On restart, restore the latest consistent checkpoint, inspect unfinished operations, reconcile uncertain side effects, and continue only when safe.

## 9. Tools

Initial tool set:

- read_file
- write_file
- apply_patch
- list_files
- search_files
- shell
- git_status
- git_diff
- git_log

Every tool needs a schema, permission classification, structured result, timeout/cancellation behavior, and tests.

## 10. Permissions and sandboxing

Modes:

- Normal: approval for sensitive operations; workspace-scoped file access.
- Auto: more autonomous execution within explicitly authorized workspace boundaries.
- Plan: read/plan only; no file modifications or shell side effects.

Implement path traversal and symlink checks, command approval, secret redaction, destructive-operation protection, and audit events.

A command allowlist alone is not a sandbox. Implement actual OS-level isolation where supported, document limitations, and never claim stronger protection than exists.

## 11. Advanced roadmap

- MCP client
- Skills system
- Subagents
- Git worktrees
- Background tasks
- Context compaction
- Image input where supported
- Diff viewer
- Usage reporting where provider data is available

These are roadmap items until implemented and tested.
