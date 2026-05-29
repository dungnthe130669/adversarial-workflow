
export const meta = {
  name: 'adversarial-migration',
  description: 'Parse migration spec, generate migration steps, adversarially verify each step, execute confirmed steps',
  phases: [
    { title: 'Parse', detail: 'Extract migration steps from MIGRATION.md' },
    { title: 'Generate', detail: 'Generate code change per step' },
    { title: 'Verify', detail: 'Adversarially validate each migration change' },
    { title: 'Execute', detail: 'Execute confirmed migration changes' },
  ],
}

const STEPS_SCHEMA = {
  type: 'object',
  properties: {
    migrationName: { type: 'string' },
    fromVersion: { type: 'string' },
    toVersion: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          description: { type: 'string' },
          breaking: { type: 'boolean' },
          rollbackPlan: { type: 'string' },
        },
        required: ['id', 'title', 'file', 'description', 'breaking', 'rollbackPlan'],
      },
    },
  },
  required: ['migrationName', 'fromVersion', 'toVersion', 'steps'],
}

const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string' },
    file: { type: 'string' },
    originalCode: { type: 'string' },
    migratedCode: { type: 'string' },
    explanation: { type: 'string' },
    isNewFile: { type: 'boolean' },
  },
  required: ['stepId', 'file', 'originalCode', 'migratedCode', 'explanation', 'isNewFile'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['stepId', 'approved', 'issues', 'suggestion'],
}

const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    executed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['file', 'executed', 'summary'],
}

// Phase 1: Parse migration spec
phase('Parse')
const specPath = args || './MIGRATION.md'
const spec = await agent(
  `Read the migration spec at ${specPath} and extract all migration steps.

For each step provide: a short id (e.g. "step1"), title, the file to modify/create, description of what to change, whether it's a breaking change (boolean), and a rollback plan if something goes wrong.
Also extract the migrationName, fromVersion, and toVersion.
Return raw JSON only.`,
  { label: 'parse-migration', phase: 'Parse', schema: STEPS_SCHEMA }
)

const breakingCount = spec.steps.filter(s => s.breaking).length
log(`Migration: ${spec.migrationName} (${spec.fromVersion} → ${spec.toVersion})`)
log(`${spec.steps.length} step(s), ${breakingCount} breaking change(s)`)

// Phase 2 + 3: Generate changes then adversarially verify
const results = await pipeline(
  spec.steps,
  // Stage 1: generate migration change
  async (step) => {
    const change = await agent(
      `You are a careful engineer performing a code migration step.

Step ID: ${step.id}
Title: ${step.title}
File: ${step.file}
Description: ${step.description}
Breaking change: ${step.breaking}
Rollback plan: ${step.rollbackPlan}

Steps:
1. If the file exists, read it first using the Read tool
2. Generate the migration change — be minimal and precise
3. If new file: set isNewFile=true, originalCode=""
4. If modifying: set originalCode to the exact lines being replaced
5. Return migratedCode as the complete replacement or new file content

Important: preserve backward compatibility where possible. If breaking, document clearly in explanation.`,
      { label: `generate:${step.id}`, phase: 'Generate', schema: CHANGE_SCHEMA }
    )
    return { step, change }
  },
  // Stage 2: adversarial verification — 2 independent reviewers
  async ({ step, change }) => {
    const [verifier1, verifier2] = await Promise.all([
      agent(
        `You are an adversarial migration reviewer focused on correctness.
Default to approved=false unless the migration change is clearly correct and complete.

Migration step: ${step.description}
Breaking: ${step.breaking}
File: ${change.file}

Original code:
\`\`\`
${change.originalCode || '(new file)'}
\`\`\`

Migrated code:
\`\`\`
${change.migratedCode}
\`\`\`

Check:
- Does it correctly implement the migration step?
- Are there syntax errors or missing imports?
- Does it handle all edge cases?
- If breaking: is the break clearly intentional and minimal?`,
        { label: `verify-correctness:${step.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      ),
      agent(
        `You are an adversarial migration reviewer focused on compatibility and rollback.
Default to approved=false unless the change is safe to apply.

Migration step: ${step.description}
Breaking: ${step.breaking}
Rollback plan: ${step.rollbackPlan}
File: ${change.file}

Original code:
\`\`\`
${change.originalCode || '(new file)'}
\`\`\`

Migrated code:
\`\`\`
${change.migratedCode}
\`\`\`

Check:
- Does it break callers that haven't been migrated yet?
- Can this change be rolled back per the rollback plan?
- Does it introduce data loss risk?
- Are there ordering dependencies with other migration steps?`,
        { label: `verify-compatibility:${step.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      )
    ])
    const votes = [verifier1, verifier2].filter(Boolean)
    const approvals = votes.filter(v => v.approved).length
    const confirmed = approvals >= Math.ceil(votes.length / 2)
    return { step, change, votes, confirmed, approvals, total: votes.length }
  }
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected = results.filter(Boolean).filter(r => !r.confirmed)

log(`Verification complete: ${confirmed.length} step(s) approved, ${rejected.length} blocked`)
for (const r of rejected) {
  const issues = r.votes.flatMap(v => v.issues)
  log(`  BLOCKED ${r.step.id} (breaking=${r.step.breaking}): ${issues.join('; ')}`)
}

// Phase 4: Execute confirmed steps
phase('Execute')
const executed = await parallel(
  confirmed.map(({ step, change, votes }) => async () => {
    const suggestionNotes = votes.map(v => v.suggestion).filter(Boolean).join('; ')
    const prompt = change.isNewFile
      ? `Create a new file at ${change.file} as part of the migration. Use the Write tool.

Content:
\`\`\`
${change.migratedCode}
\`\`\`

Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}
Return executed=true and a one-line summary.`
      : `Apply this migration change. Use the Edit tool.

File: ${change.file}
Step: ${step.title}
Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}

Replace exactly this code:
\`\`\`
${change.originalCode}
\`\`\`

With:
\`\`\`
${change.migratedCode}
\`\`\`

Read the file back to confirm. Return executed=true and a one-line summary.`

    return agent(prompt, { label: `execute:${step.id}`, phase: 'Execute', schema: EXECUTE_SCHEMA })
  })
)

const successes = executed.filter(Boolean).filter(e => e.executed)
const failures = executed.filter(Boolean).filter(e => !e.executed)

return {
  migration: spec.migrationName,
  fromVersion: spec.fromVersion,
  toVersion: spec.toVersion,
  stepsTotal: spec.steps.length,
  stepsApproved: confirmed.length,
  stepsBlocked: rejected.length,
  stepsExecuted: successes.length,
  stepsFailed: failures.length,
  breakingChanges: breakingCount,
  details: results.filter(Boolean).map(r => ({
    step: r.step.id,
    title: r.step.title,
    breaking: r.step.breaking,
    approved: r.confirmed,
    votes: `${r.approvals}/${r.total}`,
  })),
  executedSummaries: successes.map(e => e.summary),
}
