# Contributing to adversarial-workflow

Thank you for your interest in contributing! This guide covers everything you need to add a new workflow or improve an existing one.

## Project Structure

```
adversarial-workflow/
├── workflows/            # All workflow scripts live here
│   ├── adversarial-bugfix.js
│   ├── adversarial-feature.js
│   ├── adversarial-security.js
│   ├── adversarial-review.js
│   ├── adversarial-tests.js
│   ├── adversarial-deps.js
│   ├── adversarial-rca.js
│   ├── adversarial-debt.js
│   ├── adversarial-migration.js
│   ├── adversarial-crates.js
│   └── adversarial-scaffold.js
├── scripts/
│   ├── validate.js       # Checks all workflows/ JS files can be required
│   └── check-pkg.js      # Validates package.json has all required fields
├── install.js            # Post-install hook (sets up bin symlinks if needed)
├── package.json
└── README.md
```

## How to Add a New Workflow

1. **Copy the template pattern.** Duplicate the simplest existing workflow as a starting point:

   ```bash
   cp workflows/adversarial-bugfix.js workflows/adversarial-X.js
   ```

2. **Name it correctly.** The filename must follow the pattern `adversarial-X.js` where `X` is a short, lowercase, hyphenated descriptor (e.g. `adversarial-perf.js`).

3. **Use the Claude Code workflow API.** All logic must be expressed using the three primitives:

   ```js
   const { agent, pipeline, parallel } = require('@anthropic-ai/claude-code');

   // Run a single agent
   await agent({ prompt: '...' });

   // Run agents sequentially, passing output forward
   await pipeline([
     { prompt: 'Step 1: ...' },
     { prompt: 'Step 2: use the output above to ...' },
   ]);

   // Run agents concurrently
   await parallel([
     { prompt: 'Reviewer A: ...' },
     { prompt: 'Reviewer B: ...' },
   ]);
   ```

4. **Add a bin entry to `package.json`:**

   ```json
   "bin": {
     "adversarial-X": "./workflows/adversarial-X.js"
   }
   ```

5. **Add a shebang line** at the top of your script:

   ```js
   #!/usr/bin/env node
   'use strict';
   ```

6. **Document the workflow** in README.md with a short description and example invocation.

7. **Add a CHANGELOG entry** under `[Unreleased]`.

## Testing Locally

Before submitting a PR, run the validation suite:

```bash
# Verify all workflow scripts can be required without error
node scripts/validate.js

# Verify package.json has all required fields
node scripts/check-pkg.js
```

Both scripts must exit 0 before opening a PR.

To test a workflow against a real repository:

```bash
cd /path/to/some-test-repo
npx adversarial-X
```

Or, during development with a local checkout:

```bash
cd /path/to/some-test-repo
node /path/to/adversarial-workflow/workflows/adversarial-X.js
```

## Submitting a Pull Request

1. Fork the repository and create a branch: `git checkout -b feat/adversarial-X`
2. Make your changes following the guidelines above
3. Run `node scripts/validate.js` — all workflows must pass
4. Run `node scripts/check-pkg.js` — package.json must be valid
5. Update CHANGELOG.md under `[Unreleased]`
6. Open a PR using the provided PR template and fill out all sections

## Code Style

- **No external dependencies.** Workflows must use only Node.js built-ins and the Claude Code workflow API (`@anthropic-ai/claude-code`). Do not add packages to `dependencies`.
- **Pure Node.js.** No shell scripts, no Python, no compiled binaries.
- **Claude Code workflow API only.** Use `agent()`, `pipeline()`, and `parallel()` — do not invoke the Claude API directly or use `child_process` to shell out to `claude`.
- **No transpilation.** Write plain CommonJS or ESM that Node.js 18+ can run without a build step.
- **Descriptive prompts.** Agent prompts should be explicit about the expected output format, file names, and success criteria.
- **Fail loudly.** If a workflow cannot complete its task, throw an error with a clear message rather than silently producing empty output.

## Questions?

Open a GitHub Discussion or file an issue with the `question` label.
