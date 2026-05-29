# adversarial-workflow

Claude Code slash commands that use adversarial multi-agent verification — inspired by [Jarred Sumner](https://x.com/jarredsumner)'s technique for rewriting Bun from Zig to Rust in 6 days.

## How it works

Each workflow:
1. Parses a spec file to extract discrete tasks
2. Spawns independent agents per task (fix / implement / patch / migrate)
3. Runs **2 adversarial reviewers in parallel** — each has an isolated context and is prompted to find problems
4. Only applies changes that pass majority vote (≥1/2 reviewers approve)

The adversarial reviewers don't share context with the implementer, so they can't be biased by "I know why we did it this way." Their job is to prove the change wrong.

## Install

```bash
# Install globally (all projects)
npx adversarial-workflow

# Install for current project only
npx adversarial-workflow --project
```

Restart Claude Code after installing (workflows load on startup).

## Workflows

### `/adversarial-bugfix`
Fix bugs from a `REPORT.md` file.

```markdown
# REPORT.md
## Bug 1: SQL injection in login
File: src/auth.js
Description: user input concatenated directly into SQL query
Expected: parameterized queries used
Actual: `SELECT * FROM users WHERE name = '${input}'`
```

### `/adversarial-feature`
Implement features from a `FEATURE.md` file.

```markdown
# FEATURE.md
## Add rate limiting to /api/login
Limit login attempts to 5 per minute per IP.
File: src/middleware/rateLimit.js
Acceptance: returns 429 after 5 attempts, resets after 60s
```

### `/adversarial-security`
Scan codebase for vulnerabilities, propose patches, verify, apply.

```bash
/adversarial-security src/
```

### `/adversarial-migration`
Migrate code following a `MIGRATION.md` spec.

```markdown
# MIGRATION.md
## Migration: Express v4 → v5
From: 4.x
To: 5.x

### Step 1: Replace app.param() usage
File: src/routes/users.js
Breaking: true
Rollback: revert to app.param with callback signature
```

## Why adversarial?

Standard code review: reviewer knows why the author made the choice → bias.  
Adversarial review: reviewer's only context is the change itself → no bias, job is to find holes.

Two reviewers with orthogonal angles (correctness vs regressions) catch different classes of bugs. Changes only land when both agree.
