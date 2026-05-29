#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')

const args = process.argv.slice(2)
const isProject = args.includes('--project')

const workflowsDir = path.join(__dirname, 'workflows')
const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.js'))

let targetDir
if (isProject) {
  targetDir = path.join(process.cwd(), '.claude', 'workflows')
  console.log(`Installing to project: ${targetDir}`)
} else {
  targetDir = path.join(os.homedir(), '.claude', 'workflows')
  console.log(`Installing globally: ${targetDir}`)
}

fs.mkdirSync(targetDir, { recursive: true })

for (const file of files) {
  const src = path.join(workflowsDir, file)
  const dest = path.join(targetDir, file)
  fs.copyFileSync(src, dest)
  console.log(`  ✓ ${file}`)
}

console.log(`
Done! ${files.length} workflow(s) installed.

Restart Claude Code after installing — workflows load on startup.

── Construction ──────────────────────────────────────────────────────
  /adversarial-scaffold  — Greenfield: SPEC.md → design → parallel build → integration → quality gate → write
  /adversarial-feature   — Implement features from FEATURE.md (2 adversarial reviewers)

── Quality Gates ─────────────────────────────────────────────────────
  /adversarial-review    — PR review: 4 attackers (logic/security/perf/regression) → triage → post to GitHub
  /adversarial-bugfix    — Fix bugs from REPORT.md (2 adversarial verifiers)
  /adversarial-security  — Security scan + patch (2 adversarial security reviewers)
  /adversarial-tests     — Spec-driven test gen → dual review → run → triage failures

── Maintenance ───────────────────────────────────────────────────────
  /adversarial-migration — Migrate code from MIGRATION.md (2 adversarial verifiers)
  /adversarial-crates    — Split codebase into parallel crates, process + merge independently
  /adversarial-debt      — Dead code + duplicates: adversarial verify → delete confirmed, create issues for rest
  /adversarial-deps      — Dep audit: unused? stdlib-replaceable? adversarial review → remove/PR
  /adversarial-rca       — Incident RCA: 3-angle 5-why → adversarial challenge → confirmed root causes → remediations

Each workflow:
  1. Debates design before acting (parallel build + adversarial review agents)
  2. Only applies changes that survive majority adversarial vote
  3. Never touches git/build during parallel phases — defers to final step
`)
