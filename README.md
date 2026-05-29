# adversarial-workflow

[![npm version](https://img.shields.io/npm/v/adversarial-workflow.svg)](https://www.npmjs.com/package/adversarial-workflow)
[![CI](https://github.com/dungnthe130669/adversarial-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/dungnthe130669/adversarial-workflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen)](https://nodejs.org)

**11 adversarial multi-agent slash commands for Claude Code** — covering the full software development lifecycle. Each workflow pits multiple independent AI agents against each other to produce higher-quality, battle-tested output.

## How it works

Traditional AI coding: one agent proposes → you accept.

Adversarial: **attacker agents** propose solutions → **verifier agents** independently scrutinize each one → only outputs that survive verification reach you. No rubber-stamping.

```
User request
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Agent A    │     │  Agent B    │     │  Agent C    │  ← parallel attackers
│  (propose)  │     │  (propose)  │     │  (propose)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       └────────────────────┼────────────────────┘
                            ▼
                   ┌─────────────────┐
                   │  Verifier Pool  │  ← independent review
                   │  (reject/pass)  │
                   └────────┬────────┘
                            ▼
                      Final output
```

## Installation

```bash
npx adversarial-workflow install
```

This copies all 11 workflow scripts into your project's `.claude/commands/` directory, making them available as `/adversarial-*` slash commands inside Claude Code.

## Workflows

| Command | Use case |
|---|---|
| `/adversarial-bugfix` | Fix bugs: parallel patches → adversarial verification |
| `/adversarial-feature` | Build features: spec → design → parallel implementation → gate |
| `/adversarial-security` | Security audit: parallel attack vectors → exploitability scoring |
| `/adversarial-review` | PR review: 4 parallel reviewers (security/perf/correctness/style) → REVIEW.md |
| `/adversarial-tests` | Generate tests: parallel strategies → coverage gate |
| `/adversarial-deps` | Dependency audit: CVEs, outdated packages, license conflicts |
| `/adversarial-rca` | Root cause analysis: parallel hypotheses → evidence ranking |
| `/adversarial-debt` | Tech debt assessment: parallel scanners → priority-ranked backlog |
| `/adversarial-migration` | Plan migrations: parallel path analysis → risk-weighted rollout |
| `/adversarial-scaffold` | Greenfield build: spec → parallel scaffolding → integration gate |
| `/adversarial-crates` | Decompose codebase into independently buildable units |

## Usage

After installation, restart your Claude Code session and use any slash command:

```
/adversarial-bugfix   fix the authentication bypass in auth.ts
/adversarial-security audit the payment processing module
/adversarial-review   PR #142
/adversarial-tests    generate tests for UserService
```

## Requirements

- [Claude Code](https://claude.ai/code) (any version)
- Node.js ≥ 16
- No other dependencies

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to add new workflows or improve existing ones.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## License

MIT © 2025 Dung Nguyen
