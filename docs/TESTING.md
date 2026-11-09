# NellXCLI — Testing Strategy

Testing must cover CLI behavior, agent orchestration, provider integration, persistence, security, and cross-platform behavior.

## Test layers

### Unit tests

Use Vitest for:

- error classification
- account/project selection
- cooldown calculations
- retry policy
- context assembly and compaction
- path validation
- hierarchical `.gitignore` precedence and protected-path exclusions
- nested `AGENTS.md` preflight before targeted and recursive file tools run
- tool schema validation
- session state transitions
- CLI abort handling for SIGINT and SIGTERM

### Integration tests

Use temporary directories and isolated SQLite databases for:

- storage transactions
- account/profile persistence
- credential references
- tool registry
- provider adapter with mocked SDK responses
- session restore/checkpoint behavior

### Provider contract and smoke tests

- Mocked contract tests run in CI.
- Real Gemini API smoke tests are opt-in and require a user-provided test credential. Enable the model discovery smoke test with `NELLX_GEMINI_SMOKE=1` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`); it is skipped by default.
- Never expose API keys in test output.
- Do not make CI depend on paid or rate-limited live API calls.

Postman/Newman may be used for HTTP contract tests if NellXCLI exposes an HTTP service. The core CLI itself should be tested with CLI-level E2E tests rather than forcing it into Postman.

### CLI E2E tests

Test the actual executable in a temporary workspace:

- `--help` and `--version`
- non-interactive prompt
- config commands
- account add/list/remove
- model listing/selection
- approval behavior
- session create/resume
- exit codes and signals

Use node-pty only where a real pseudo-terminal is required. Keep non-TTY tests simpler and more deterministic.

### Failover E2E scenarios

Use a deterministic fake provider with scripted outcomes:

1. Project A succeeds.
2. Project A returns quota exhaustion.
3. Project B is selected.
4. Agent continues with the same session ID.
5. Existing plan and completed tool results remain available.
6. Final output and diff are not duplicated.

Additional scenarios:

- invalid key quarantined
- permission error does not blindly rotate
- transient 503 uses bounded backoff
- same-project alternate key does not bypass project cooldown
- all projects unavailable produces a clear recoverable error
- partial stream failure does not duplicate visible output
- uncertain tool operation is reconciled before replay

### Security tests

- path traversal
- symlink escape
- shell command approval
- secret redaction in logs
- credential persistence
- malicious tool arguments
- workspace boundary enforcement

## CI matrix

Run on:

- Windows
- macOS
- Linux

At minimum:

- install
- lint
- typecheck
- unit tests
- integration tests
- build

Run full terminal E2E tests where the runner supports the required terminal behavior.

## Test reporting

For every milestone, report:

- commands executed
- pass/fail counts
- skipped tests and reasons
- platform coverage
- known limitations

Never describe a mocked test as proof of real provider availability.

## Native keyring checks

`test/accounts/keyring.platform.test.ts` performs a disposable write/read/delete test against the real platform keyring on macOS and Windows CI. Linux skips this integration by default because headless Codespaces and GitHub runners usually lack a Secret Service; set `NELLX_RUN_LINUX_KEYRING=1` only in an environment with an unlocked Secret Service. The encrypted-vault tests remain platform-independent.

## Manual TTY smoke

A Linux Codespaces PTY smoke check verified TUI startup, `/help`, `/sessions`, switching to Plan mode, graceful `/quit`, and idle Ctrl-C returning status 130 using an isolated `XDG_CONFIG_HOME`. It did not exercise live model streaming, approvals, in-flight cancellation, resume, or diff; Windows and macOS TTY checks remain pending.
