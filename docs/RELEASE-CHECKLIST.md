# Release checklist

## Required before a public release

- [ ] Complete Windows/macOS/Linux CI on Node.js 22.
- [ ] Verify native keyring write/read/delete on each supported OS; Windows/macOS CI now exercises the integration test, and Linux requires a configured Secret Service.
- [ ] Complete security review for path races, shell approval, secret handling, database file permissions, and dependency changes.
- [ ] Run credential-backed Gemini smoke test without recording secrets.
- [ ] Review API and provider behavior against current Google AI Studio documentation.
- [ ] Verify package install, command execution, upgrade, and uninstall on each supported OS.
- [ ] Manually exercise TUI input, streaming, approvals, cancellation, session resume, diff, modes, and exit on supported terminals on each OS.
- [ ] Confirm npm package name, ownership, version, license, README, and provenance policy; remove `private: true` only after the maintainer explicitly prepares a release.
- [ ] Publish only after explicit maintainer approval.
- [ ] Tag the source revision and archive CI/audit results.

## Current local checks

The repository's CI workflow runs formatting, lint, typecheck, unit tests, build, production dependency audit, and package install/CLI/uninstall smoke checks on Linux, macOS, and Windows. Codespaces validation can prove only the Linux leg; passing it does not complete the cross-platform or credential-backed release checks above.
