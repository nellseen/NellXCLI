# NellXCLI

NellXCLI is an independent, cross-platform, Gemini-powered terminal coding agent inspired by the workflow and capabilities of Codex CLI.

## Project decisions

- Language: TypeScript
- Runtime: Node.js 22+
- Package manager: pnpm
- Platforms: Windows, macOS, Linux
- Initial provider: Google AI Studio / Gemini API
- Experience target: full Codex-like workflow
- Account management: multiple user-managed Google AI Studio accounts/projects
- Reliability: account/project-aware failover with persistent agent context
- Testing: unit, integration, CLI E2E, provider contract/smoke tests

## Important distinction: accounts, projects, and API keys

An API key is a credential, not an account. A Google AI Studio account label is metadata supplied by the user; the application must not claim it has verified the underlying Google identity unless Google provides a supported verification mechanism.

A managed account entry should identify its associated Google Cloud project and one or more API keys. Gemini API rate limits are generally applied at the project level, with model-specific dimensions. Rotating between keys in the same project does not create a fresh project quota. Failover should select another eligible, independently configured project when appropriate and must not be designed to evade Google's limits, billing controls, or enforcement.

## Development

Requirements: Node.js 22+ and pnpm 12.16.1.

```sh
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node dist/index.js --help
node dist/index.js models list
node dist/index.js accounts list
```

Run `nellx` in a terminal to open chat. On first launch it guides you through connecting Google AI Studio, validating a key, choosing an available model, and selecting a workspace. It saves the credential through the OS keyring when available, otherwise it asks for a vault passphrase and stores the key in the encrypted vault. The passphrase is requested again when a new terminal session needs to unlock the vault. NellXCLI does not store API keys in SQLite or ordinary settings. Environment API keys are currently used only by the opt-in provider smoke test; agent runtime and `nellx models list` both use configured account credentials.

Use `nellx setup` to open the setup flow again. `nellx models list`, `nellx accounts ...`, `nellx run <prompt>`, and `nellx sessions list` remain available as explicit commands. The chat supports `/new`, `/sessions`, `/resume <id>`, `/model [id]`, `/account`, `/workspace [path]`, `/diff`, `/mode normal|auto|plan`, and `/quit`.

`nellx run <prompt> --workspace <path> --mode normal|auto|plan --model <id>` starts a persisted agent run. Add `--image path/to/image.png` (repeat up to four times) to send workspace images to Gemini; image bytes are not persisted. Normal mode asks before writes and shell commands; Auto mode allows workspace file edits and still asks before shell commands; Plan mode is read-only. Use `--session <id>` to continue a prior session and `nellx sessions list` to find IDs. Running `nellx` in a terminal opens Ink chat with `/help`, `/sessions`, `/resume <id>`, `/diff`, `/mode normal|auto|plan`, and `/quit`; Ctrl-C cancels an active response. For pipelines, `nellx run -` reads a bounded prompt from stdin. Richer visual diff and task controls remain incomplete. Tool calls use a bounded JSON protocol over text generation. No OS-level sandbox is implemented, so shell commands remain approval-gated and run with the user's privileges.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md)
- [Testing strategy](docs/TESTING.md)
- [Security model](docs/SECURITY.md)
- [Release checklist](docs/RELEASE-CHECKLIST.md)
- [Codex implementation prompt](docs/CODEX-IMPLEMENTATION-PROMPT.md)

## Scope note

This repository is an incremental development blueprint. It does not contain a production-ready coding agent or sandbox.

## MCP servers

Configure local stdio MCP servers in `.nellx/mcp.json`; NellXCLI requires approval for discovery and each remote tool call. See [MCP client security and configuration](docs/MCP.md).

## Image input

The non-interactive Gemini run command supports workspace-relative PNG, JPEG, WebP, and GIF attachments. See [image input limits and privacy](docs/IMAGE-INPUT.md).

## Background tasks

The agent can launch approved argv-only background processes, poll session-scoped status, and request cancellation. Output is discarded; see [background task behavior and limits](docs/BACKGROUND-TASKS.md).

## Subagents

`delegate_readonly` creates a bounded, persisted worker session with read-only workspace tools. See [subagent behavior and limits](docs/SUBAGENTS.md).
