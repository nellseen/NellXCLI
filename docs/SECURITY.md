# NellXCLI — Security Model

## Secrets

- Store API keys in OS credential stores where available.
- Provide an encrypted vault fallback.
- Never store plaintext keys in ordinary JSON, SQLite rows, source code, fixtures, or logs.
- Redact credentials from exceptions and diagnostic bundles.
- Do not collect Google account passwords or browser cookies.

## Account metadata

Account names and email labels are user-provided metadata unless a supported Google identity verification flow is explicitly implemented. Do not represent labels as verified identities.

## Workspace access

- Resolve paths before access.
- Reject traversal outside the authorized workspace.
- Validate symlinks to prevent escapes.
- Treat archives, generated files, and model-provided paths as untrusted.
- Make destructive operations approval-gated in Normal mode.

## Shell execution

- Model-generated commands are untrusted.
- Display the command and working directory before approval when required.
- Support timeouts, cancellation, and output limits.
- Avoid implicit shell interpolation.
- Do not claim an allowlist is equivalent to sandboxing.
- Use OS-level isolation where implemented and document platform differences.

## Provider failover

Failover is intended for reliability across user-configured, eligible projects. It must not:
- evade project quota or billing controls
- bypass account restrictions
- automate account creation
- hide policy or safety errors
- retry permanent errors indefinitely

## Telemetry

Default to local-only operation. If telemetry is ever introduced, make it explicit, minimal, documented, and opt-in. Never include secrets or source code in telemetry.
