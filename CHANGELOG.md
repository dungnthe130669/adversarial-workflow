# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] - 2025-05-29

### Added
- `adversarial-tests` — adversarial test generation pipeline: one agent writes tests, a second attempts to break them, a third reconciles
- `adversarial-deps` — dependency audit workflow: parallel agents analyze each dependency for security, compatibility, and necessity
- `adversarial-rca` — root cause analysis workflow: multi-agent investigation pipeline producing a structured RCA report
- `adversarial-debt` — technical debt assessment: parallel agents score modules for complexity, coverage, and coupling; produces DEBT.md

### Changed
- Full software lifecycle now covered across 11 workflows: bugfix, feature, security, review, tests, deps, rca, debt, migration, crates, scaffold

## [2.3.0] - 2025-05-29

### Added
- `adversarial-review` — parallel PR review workflow: spawns multiple independent reviewer agents, merges findings into REVIEW.md output

## [2.2.0] - 2025-05-29

### Added
- `adversarial-scaffold` — greenfield project build pipeline: agents collaboratively design architecture, generate boilerplate, and validate the result

## [2.1.0] - 2025-05-29

### Added
- `adversarial-crates` — parallel codebase decomposition workflow: agents independently analyse the repo and propose module/crate boundaries, producing a CRATES.md consensus
- `adversarial-migration` — migration workflow: agents plan, execute, and verify large-scale codebase migrations (framework upgrades, language migrations, etc.)

## [2.0.1] - 2025-05-29

### Fixed
- Verifier agent scope narrowed to evaluate only the specific bug it was assigned, not the entire file — eliminates spurious failures on unrelated code

## [2.0.0] - 2025-05-29

### Changed
- **Breaking:** Rewrote all workflows as proper JavaScript scripts using the Claude Code `agent()`, `pipeline()`, and `parallel()` APIs — replaces the previous shell-script approach
- Each workflow now runs as a native Node.js module; no shell dependencies required
- Output files (BUGS.md, SECURITY.md, etc.) are produced programmatically with structured content

## [1.0.0] - 2025-05-29

### Added
- Initial release
- `adversarial-bugfix` — multi-agent bug hunting and fixing pipeline
- `adversarial-feature` — adversarial feature development: proposer vs. critic agents
- `adversarial-security` — parallel security audit workflow producing SECURITY.md

[Unreleased]: https://github.com/your-org/adversarial-workflow/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/your-org/adversarial-workflow/compare/v2.3.0...v3.0.0
[2.3.0]: https://github.com/your-org/adversarial-workflow/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/your-org/adversarial-workflow/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/your-org/adversarial-workflow/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/your-org/adversarial-workflow/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/your-org/adversarial-workflow/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/your-org/adversarial-workflow/releases/tag/v1.0.0
