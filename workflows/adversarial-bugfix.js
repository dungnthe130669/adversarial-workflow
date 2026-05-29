
export const meta = {
  name: 'adversarial-bugfix',
  description: 'Parse bug report, propose fixes per bug, adversarially verify each fix, apply confirmed fixes',
  phases: [
    { title: 'Parse', detail: 'Extract bugs from REPORT.md' },
    { title: 'Fix', detail: 'Propose a fix per bug' },
    { title: 'Verify', detail: 'Adversarially challenge each proposed fix' },
    { title: 'Apply', detail: 'Apply confirmed fixes' },
  ],
}

const BUGS_SCHEMA = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          description: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
        },
        required: ['id', 'title', 'file', 'description', 'expected', 'actual'],
      },
    },
  },
  required: ['bugs'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    bugId: { type: 'string' },
    file: { type: 'string' },
    analysis: { type: 'string' },
    originalCode: { type: 'string' },
    fixedCode: { type: 'string' },
    explanation: { type: 'string' },
  },
  required: ['bugId', 'file', 'analysis', 'originalCode', 'fixedCode', 'explanation'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    bugId: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['bugId', 'approved', 'issues', 'suggestion'],
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    applied: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['file', 'applied', 'summary'],
}

// Phase 1: Parse bug report
phase('Parse')
const reportPath = args || './REPORT.md'
const parsed = await agent(
  `Read the bug report at ${reportPath} and extract all bugs into structured data.
For each bug extract: a short id (e.g. "bug1"), title, file path, description, expected behavior, actual behavior.
Return raw JSON only.`,
  { label: 'parse-report', phase: 'Parse', schema: BUGS_SCHEMA }
)

log(`Found ${parsed.bugs.length} bug(s): ${parsed.bugs.map(b => b.title).join(', ')}`)

// Phase 2 + 3: pipeline — propose fix, then adversarially verify
const results = await pipeline(
  parsed.bugs,
  // Stage 1: propose fix
  async (bug) => {
    const fix = await agent(
      `You are a careful software engineer. Analyze and fix this bug:

Bug ID: ${bug.id}
Title: ${bug.title}
File: ${bug.file}
Description: ${bug.description}
Expected: ${bug.expected}
Actual: ${bug.actual}

Steps:
1. Read the file at ${bug.file} using the Read tool
2. Identify the root cause
3. Write the minimal correct fix
4. Return originalCode (the exact lines to replace) and fixedCode (replacement)

Be precise — your fix must match the actual file contents exactly.`,
      { label: `fix:${bug.id}`, phase: 'Fix', schema: FIX_SCHEMA }
    )
    return { bug, fix }
  },
  // Stage 2: adversarial verification — 2 independent skeptics
  async ({ bug, fix }) => {
    const [skeptic1, skeptic2] = await Promise.all([
      agent(
        `You are an adversarial code reviewer. Try to find problems with this proposed fix.
Default to approved=false unless the fix is clearly correct and complete.

Bug: ${bug.description}
Expected: ${bug.expected}
Actual: ${bug.actual}
File: ${fix.file}

Original code:
\`\`\`
${fix.originalCode}
\`\`\`

Proposed fix:
\`\`\`
${fix.fixedCode}
\`\`\`

Reviewer angle: correctness and edge cases.
IMPORTANT: Only evaluate this specific bug (${bug.id}) and its fix. Do NOT reject because other bugs exist elsewhere in the file — each bug is fixed independently.
Check: Does it actually fix THIS bug? Does it break other cases? Are there off-by-one or null/undefined edge cases?`,
        { label: `verify-correctness:${bug.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      ),
      agent(
        `You are an adversarial code reviewer. Try to find problems with this proposed fix.
Default to approved=false unless the fix is clearly correct and complete.

Bug: ${bug.description}
Expected: ${bug.expected}
Actual: ${bug.actual}
File: ${fix.file}

Original code:
\`\`\`
${fix.originalCode}
\`\`\`

Proposed fix:
\`\`\`
${fix.fixedCode}
\`\`\`

Reviewer angle: regressions and spec alignment.
IMPORTANT: Only evaluate this specific bug (${bug.id}) and its fix. Do NOT reject because other bugs exist elsewhere in the file — each bug is fixed independently.
Check: Does the fix match the spec exactly? Could it break callers that depend on current behavior? Does it introduce new bugs?`,
        { label: `verify-regressions:${bug.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      )
    ])
    const votes = [skeptic1, skeptic2].filter(Boolean)
    const approvals = votes.filter(v => v.approved).length
    const confirmed = approvals >= Math.ceil(votes.length / 2)
    return { bug, fix, votes, confirmed, approvals, total: votes.length }
  }
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected = results.filter(Boolean).filter(r => !r.confirmed)

log(`Verification complete: ${confirmed.length} fix(es) confirmed, ${rejected.length} rejected`)
for (const r of rejected) {
  const issues = r.votes.flatMap(v => v.issues)
  log(`  REJECTED ${r.bug.id}: ${issues.join('; ')}`)
}

// Phase 4: Apply confirmed fixes
phase('Apply')
const applied = await parallel(
  confirmed.map(({ bug, fix, votes }) => async () => {
    const suggestionNotes = votes.map(v => v.suggestion).filter(Boolean).join('; ')
    return agent(
      `Apply this confirmed code fix to the file. Use the Edit tool to make the change.

File: ${fix.file}
Bug fixed: ${bug.title}
Verifier notes (incorporate if relevant): ${suggestionNotes || 'none'}

Replace exactly this code (old_string):
\`\`\`
${fix.originalCode}
\`\`\`

With this code (new_string):
\`\`\`
${fix.fixedCode}
\`\`\`

After applying, read the file back and confirm the change is present.
Return applied=true if the edit succeeded, false otherwise, and a one-line summary.`,
      { label: `apply:${bug.id}`, phase: 'Apply', schema: APPLY_SCHEMA }
    )
  })
)

const successes = applied.filter(Boolean).filter(a => a.applied)
const failures = applied.filter(Boolean).filter(a => !a.applied)

return {
  bugsFound: parsed.bugs.length,
  fixesConfirmed: confirmed.length,
  fixesRejected: rejected.length,
  fixesApplied: successes.length,
  fixesFailed: failures.length,
  details: results.filter(Boolean).map(r => ({
    bug: r.bug.id,
    title: r.bug.title,
    confirmed: r.confirmed,
    approvals: `${r.approvals}/${r.total}`,
  })),
  appliedSummaries: successes.map(a => a.summary),
}
