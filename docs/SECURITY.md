# NellXCLI — Security Model

## Secrets

- Store API keys in OS credential stores where available.
- Provide an encrypted vault fallback.
- Never store plaintext keys in ordinary JSON, SQLite rows, source code, fixtures, or logs.
- Redact credentials from exceptions and diagnostic bundles.
- Do not collect Google account passwords or browser cookies.

## Encrypted credential vault

When the OS credential store is unavailable, API keys can be stored in `credentials.vault`. Each value is encrypted with AES-256-GCM using a unique random salt and nonce; scrypt derives a key from `NELLX_VAULT_PASSPHRASE`. The passphrase is not saved. The vault directory and file are created with owner-only permissions where the platform supports POSIX modes. The SQLite database stores only a backend and credential reference.

The vault protects credentials at rest from casual file disclosure. It does not protect against compromise of the logged-in OS account, malware running as the user, process-memory inspection, or exposure of the passphrase in the process environment. Back up the vault and passphrase separately; losing the passphrase makes its credentials unrecoverable.

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
- Display the redacted arguments and authorized workspace before approval; reject approval previews larger than 16 KB rather than hiding their tail.
- Support timeouts, cancellation, and output limits.
- Background task argv is omitted from persisted session history and task metadata; task output is discarded. Background process status files live under ignored `.nellx/tasks/`.
- Read-only subagents use a separate session and a read-only tool registry; this application-level policy is not an OS sandbox.
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
