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

## Quick start for contributors

1. Install Node.js 22+ and pnpm.
2. Read `AGENTS.md`.
3. Read `docs/ARCHITECTURE.md`.
4. Read `docs/IMPLEMENTATION-PLAN.md`.
5. Ask Codex CLI to inspect the repository and implement only the first milestone.
6. Run tests and report actual results; do not claim tests passed unless executed.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md)
- [Testing strategy](docs/TESTING.md)
- [Security model](docs/SECURITY.md)
- [Codex implementation prompt](docs/CODEX-IMPLEMENTATION-PROMPT.md)

## Scope note

This archive is a planning and development blueprint, not a completed CLI implementation. It does not contain a working NellXCLI executable or production-ready sandbox.
