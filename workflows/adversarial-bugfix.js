export const meta = {
  name: 'adversarial-bugfix',
  description: 'Jarred Sumner pattern: split REPORT.md → parallel fix+2-adversarial-review (no git/build) → apply all → build → test → commit → PR',
  phases: [
    { title: 'Split',  detail: 'Split REPORT.md into individual bug files' },
    { title: 'Fix',    detail: 'Propose fix per bug (no git, no build)' },
    { title: 'Refute', detail: '2 independent agents try to disprove each fix' },
    { title: 'Apply',  detail: 'Apply confirmed fixes' },
    { title: 'Ship',   detail: 'Build → test → commit → PR' },
  ],
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const BUG_SCHEMA = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    title:       { type: 'string' },
    file:        { type: 'string' },
    description: { type: 'string' },
    expected:    { type: 'string' },
    actual:      { type: 'string' },
  },
  required: ['id', 'title', 'file', 'description', 'expected', 'actual'],
}

const BUGS_SCHEMA = {
  type: 'object',
  properties: { bugs: { type: 'array', items: BUG_SCHEMA } },
  required: ['bugs'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    bugId:        { type: 'string' },
    file:         { type: 'string' },
    analysis:     { type: 'string' },
    originalCode: { type: 'string' },
    fixedCode:    { type: 'string' },
    explanation:  { type: 'string' },
  },
  required: ['bugId', 'file', 'analysis', 'originalCode', 'fixedCode', 'explanation'],
}

const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    bugId:     { type: 'string' },
    approved:  { type: 'boolean' },
    flaws:     { type: 'array', items: { type: 'string' } },
    verdict:   { type: 'string' },
  },
  required: ['bugId', 'approved', 'flaws', 'verdict'],
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    bugId:   { type: 'string' },
    applied: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['bugId', 'applied', 'summary'],
}

const SHIP_SCHEMA = {
  type: 'object',
  properties: {
    buildPassed: { type: 'boolean' },
    testsPassed: { type: 'boolean' },
    commitSha:   { type: 'string' },
    prUrl:       { type: 'string' },
    notes:       { type: 'string' },
  },
  required: ['buildPassed', 'testsPassed', 'commitSha', 'prUrl'],
}

// ─── Phase 1: Split REPORT.md → individual bug files ────────────────────────

phase('Split')
log('Reading REPORT.md and splitting into individual bug files...')

const parsed = await agent(
  `Read the file ./REPORT.md and extract every bug into structured JSON.
For each bug include: id (e.g. BUG-001), title, file path affected, description of the bug, expected behavior, actual behavior.
Write each bug as a separate file: ./bugs/BUG-001.json, ./bugs/BUG-002.json, etc.
Return the full list as JSON matching the schema.`,
  { label: 'split', phase: 'Split', schema: BUGS_SCHEMA }
)

if (!parsed?.bugs?.length) {
  log('No bugs found in REPORT.md — nothing to do.')
  return { bugsFound: 0 }
}

log(`Found ${parsed.bugs.length} bug(s) — splitting into parallel tracks...`)

// ─── Phase 2+3: Per-bug parallel: fix → 2 adversarial refuters ──────────────

phase('Fix')
phase('Refute')

const NO_GIT_BUILD = `
IMPORTANT CONSTRAINTS (you are one of many agents running in parallel on the same branch):
- Do NOT run any git commands (git add, git commit, git push, git checkout, etc.)
- Do NOT run any build commands (npm run build, bun build, make, cargo build, etc.)
- Do NOT run any test commands
- Only read files and write/edit code changes
Violating these constraints will corrupt the shared workspace.`

const results = await parallel(
  parsed.bugs.map(bug => async () => {

    // Agent A: fix the bug
    const fix = await agent(
      `You are fixing a single bug. Read ./bugs/${bug.id}.json for full details.

Bug: ${bug.id} — ${bug.title}
File: ${bug.file}

Task:
1. Read the affected file(s)
2. Understand the root cause
3. Write the minimal fix
4. Return the fix as JSON (originalCode + fixedCode must be exact strings from the file)
${NO_GIT_BUILD}`,
      { label: `fix:${bug.id}`, phase: 'Fix', schema: FIX_SCHEMA }
    )

    if (!fix) return { bug, fix: null, refutations: [], confirmed: false }

    // Agent B + C: independently try to disprove the fix
    const [refuter1, refuter2] = await parallel([
      async () => agent(
        `You are an adversarial reviewer. Your ONLY job is to REFUTE this bugfix — find every flaw, edge case, regression, or incorrect assumption. Be ruthless.

Bug: ${bug.id} — ${bug.title}
File: ${fix.file}

Proposed fix:
BEFORE:
\`\`\`
${fix.originalCode}
\`\`\`
AFTER:
\`\`\`
${fix.fixedCode}
\`\`\`

Fixer's explanation: ${fix.explanation}

Your angle: SECURITY + CORRECTNESS. Does this fix introduce new vulnerabilities? Does it actually solve the root cause or just mask symptoms? Are there inputs that still trigger the bug?
Set approved=false if you find ANY serious flaw. Only approve if the fix is airtight.
${NO_GIT_BUILD}`,
        { label: `refute-security:${bug.id}`, phase: 'Refute', schema: REFUTE_SCHEMA }
      ),
      async () => agent(
        `You are an adversarial reviewer. Your ONLY job is to REFUTE this bugfix — find every flaw, edge case, regression, or incorrect assumption. Be ruthless.

Bug: ${bug.id} — ${bug.title}
File: ${fix.file}

Proposed fix:
BEFORE:
\`\`\`
${fix.originalCode}
\`\`\`
AFTER:
\`\`\`
${fix.fixedCode}
\`\`\`

Fixer's explanation: ${fix.explanation}

Your angle: REGRESSIONS + SPEC. Could this break callers that depend on current behavior? Does it match the spec exactly? Does it introduce new bugs elsewhere?
Set approved=false if you find ANY serious flaw. Only approve if the fix is airtight.
${NO_GIT_BUILD}`,
        { label: `refute-regression:${bug.id}`, phase: 'Refute', schema: REFUTE_SCHEMA }
      ),
    ])

    const refutations = [refuter1, refuter2].filter(Boolean)
    const approvals = refutations.filter(r => r.approved).length
    const confirmed = approvals >= Math.ceil(refutations.length / 2)

    if (!confirmed) {
      const flaws = refutations.flatMap(r => r.flaws)
      log(`  REJECTED ${bug.id}: ${flaws.join('; ')}`)
    } else {
      log(`  CONFIRMED ${bug.id}: ${approvals}/${refutations.length} refuters approved`)
    }

    return { bug, fix, refutations, confirmed, approvals, total: refutations.length }
  })
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected  = results.filter(Boolean).filter(r => !r.confirmed)

log(`\nVerification: ${confirmed.length} confirmed, ${rejected.length} rejected`)

// ─── Phase 4: Apply all confirmed fixes ────────────────────────────────────

phase('Apply')

const applied = await parallel(
  confirmed.map(({ bug, fix, refutations }) => async () => {
    const notes = refutations.map(r => r.verdict).filter(Boolean).join(' | ')
    return agent(
      `Apply this confirmed bugfix using the Edit tool. Make the exact change specified — no more, no less.

File: ${fix.file}
Bug: ${bug.id} — ${bug.title}

Replace EXACTLY this code:
\`\`\`
${fix.originalCode}
\`\`\`

With EXACTLY this code:
\`\`\`
${fix.fixedCode}
\`\`\`

Reviewer notes to incorporate if relevant: ${notes || 'none'}

After editing, read the file back to confirm the change is present. Return applied=true if successful.`,
      { label: `apply:${bug.id}`, phase: 'Apply', schema: APPLY_SCHEMA }
    )
  })
)

const successes = applied.filter(Boolean).filter(a => a.applied)
const failures  = applied.filter(Boolean).filter(a => !a.applied)
log(`Applied: ${successes.length} succeeded, ${failures.length} failed`)

// ─── Phase 5: Build → test → commit → PR ───────────────────────────────────

phase('Ship')

const branchName = `fix/adversarial-${Date.now()}`
const commitMsg  = confirmed.map(r => `fix(${r.bug.id}): ${r.bug.title}`).join('\n')

const ship = await agent(
  `All bugfixes have been applied. Now ship them:

1. Create a new branch: git checkout -b ${branchName}
2. Run the build command for this project (detect from package.json / Makefile / Cargo.toml / etc.)
3. Run the relevant tests for the files that were changed
4. If build and tests pass: git add -A && git commit -m "${commitMsg}"
5. git push origin ${branchName}
6. Open a PR with title "fix: adversarial bugfix batch (${confirmed.length} bugs)" and body listing each bug fixed
7. Return buildPassed, testsPassed, commitSha, prUrl

Bugs fixed in this batch:
${confirmed.map(r => `- ${r.bug.id}: ${r.bug.title} (${r.fix.file})`).join('\n')}

If build fails, report the error in notes and set buildPassed=false. Do NOT force-push or skip tests.`,
  { label: 'ship', phase: 'Ship', schema: SHIP_SCHEMA }
)

// ─── Summary ────────────────────────────────────────────────────────────────

return {
  bugsFound:      parsed.bugs.length,
  confirmed:      confirmed.length,
  rejected:       rejected.length,
  applied:        successes.length,
  buildPassed:    ship?.buildPassed ?? false,
  testsPassed:    ship?.testsPassed ?? false,
  commitSha:      ship?.commitSha ?? null,
  prUrl:          ship?.prUrl ?? null,
  rejectedBugs:   rejected.map(r => ({
    id:    r.bug.id,
    title: r.bug.title,
    flaws: r.refutations.flatMap(x => x.flaws),
  })),
  appliedBugs: successes.map(a => a.bugId),
}
