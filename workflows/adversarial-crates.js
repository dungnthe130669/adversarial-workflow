
export const meta = {
  name: 'adversarial-crates',
  description: 'Split codebase into independent modules (crates), process each in parallel with adversarial review, merge confirmed changes',
  phases: [
    { title: 'Decompose', detail: 'Split codebase into independent crates' },
    { title: 'Process', detail: 'Apply task to each crate in parallel' },
    { title: 'Review', detail: 'Adversarially review each crate result' },
    { title: 'Merge', detail: 'Merge confirmed crate changes' },
  ],
}

const CRATES_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    crates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'string' } },
          interfaces: { type: 'string' },
        },
        required: ['id', 'name', 'files', 'description', 'dependencies', 'interfaces'],
      },
    },
  },
  required: ['task', 'crates'],
}

const CRATE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    crateId: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          originalCode: { type: 'string' },
          newCode: { type: 'string' },
          isNewFile: { type: 'boolean' },
        },
        required: ['file', 'originalCode', 'newCode', 'isNewFile'],
      },
    },
    summary: { type: 'string' },
    interfaceChanges: { type: 'string' },
  },
  required: ['crateId', 'changes', 'summary', 'interfaceChanges'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    crateId: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['crateId', 'approved', 'issues', 'suggestion'],
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

// Phase 1: Decompose codebase into independent crates
phase('Decompose')
const taskDesc = args || 'Refactor and improve the codebase'
const decomp = await agent(
  `You are a senior architect. Analyze the codebase in the current directory and decompose it into independent modules ("crates") for parallel processing.

Task to perform across all crates: ${taskDesc}

Rules for decomposition:
1. Each crate = a cohesive group of files that can be modified INDEPENDENTLY
2. Minimize cross-crate dependencies — changes in one crate must NOT require simultaneous changes in another
3. List each crate's PUBLIC interfaces (exports, APIs, function signatures) that other crates depend on
4. If crate A depends on crate B's interface, list B in A's dependencies array
5. Aim for 3-8 crates (too many = overhead, too few = no parallelism benefit)

Steps:
1. List all source files in the project (use Glob or LS tool)
2. Group related files into crates
3. Document interfaces between crates

Return raw JSON only.`,
  { label: 'decompose-codebase', phase: 'Decompose', schema: CRATES_SCHEMA }
)

log(`Task: ${decomp.task}`)
log(`Decomposed into ${decomp.crates.length} crate(s):`)
for (const c of decomp.crates) {
  log(`  ${c.id} (${c.name}): ${c.files.join(', ')} — deps: [${c.dependencies.join(', ') || 'none'}]`)
}

// Phase 2 + 3: Process each crate in parallel, then adversarially review
// Sort by dependency order — process independent crates first
const sorted = [...decomp.crates].sort((a, b) => {
  const aDepsB = a.dependencies.includes(b.id)
  const bDepsA = b.dependencies.includes(a.id)
  if (bDepsA) return -1 // b depends on a → a first
  if (aDepsB) return 1  // a depends on b → b first
  return 0
})

const results = await pipeline(
  sorted,
  // Stage 1: process the crate (task applied independently)
  async (crate) => {
    const result = await agent(
      `You are an expert software engineer. Apply the following task to the files in this crate ONLY.

Task: ${decomp.task}

Crate: ${crate.name} (${crate.id})
Files to modify: ${crate.files.join(', ')}
Description: ${crate.description}
Public interfaces (DO NOT break these): ${crate.interfaces}
Dependencies on other crates: ${crate.dependencies.join(', ') || 'none'}

IMPORTANT constraints:
- Only modify files in this crate: ${crate.files.join(', ')}
- Do NOT change the public interfaces listed above (other crates depend on them)
- Do NOT modify files from other crates
- Each change: provide file path, exact originalCode to replace, and newCode replacement
- If creating a new file: set isNewFile=true, originalCode=""
- Document any interface changes you had to make (ideally: none)

Steps:
1. Read each file in this crate
2. Apply the task with minimal, clean changes
3. Return all changes as an array`,
      { label: `process:${crate.id}`, phase: 'Process', schema: CRATE_RESULT_SCHEMA }
    )
    return { crate, result }
  },
  // Stage 2: adversarial review — 2 independent reviewers
  async ({ crate, result }) => {
    const [reviewer1, reviewer2] = await Promise.all([
      agent(
        `You are an adversarial code reviewer. Evaluate this crate's changes for correctness.
Default to approved=false unless ALL changes are clearly correct.
IMPORTANT: Only evaluate this crate (${crate.id}). Do NOT reject because other crates haven't been updated yet.

Task performed: ${decomp.task}
Crate: ${crate.name}
Files changed: ${result.changes.map(c => c.file).join(', ')}
Summary: ${result.summary}
Interface changes: ${result.interfaceChanges || 'none'}

Changes:
${result.changes.map(c => `
File: ${c.file}
Original:
\`\`\`
${c.originalCode || '(new file)'}
\`\`\`
New:
\`\`\`
${c.newCode}
\`\`\`
`).join('\n---\n')}

Check:
- Does it correctly apply the task within this crate's scope?
- Are public interfaces preserved (no breaking changes to: ${crate.interfaces})?
- Edge cases, null checks, type errors?
- Does it introduce bugs within this crate?`,
        { label: `review-correctness:${crate.id}`, phase: 'Review', schema: VERDICT_SCHEMA }
      ),
      agent(
        `You are an adversarial code reviewer. Evaluate this crate's changes for interface safety and regressions.
Default to approved=false unless the changes are clearly safe for parallel merging.
IMPORTANT: Only evaluate this crate (${crate.id}). Do NOT reject because other crates haven't been updated yet.

Task performed: ${decomp.task}
Crate: ${crate.name}
Dependencies: ${crate.dependencies.join(', ') || 'none'}
Public interfaces that must be preserved: ${crate.interfaces}
Interface changes reported: ${result.interfaceChanges || 'none'}

Changes:
${result.changes.map(c => `
File: ${c.file}
Original:
\`\`\`
${c.originalCode || '(new file)'}
\`\`\`
New:
\`\`\`
${c.newCode}
\`\`\`
`).join('\n---\n')}

Check:
- Are public interfaces truly preserved? (callers from other crates will break if not)
- Could these changes conflict with parallel changes in other crates?
- Is the code style consistent with the original?
- Any performance regressions?`,
        { label: `review-interfaces:${crate.id}`, phase: 'Review', schema: VERDICT_SCHEMA }
      )
    ])
    const votes = [reviewer1, reviewer2].filter(Boolean)
    const approvals = votes.filter(v => v.approved).length
    const confirmed = approvals >= Math.ceil(votes.length / 2)
    return { crate, result, votes, confirmed, approvals, total: votes.length }
  }
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected = results.filter(Boolean).filter(r => !r.confirmed)

log(`Review complete: ${confirmed.length} crate(s) approved, ${rejected.length} rejected`)
for (const r of rejected) {
  const issues = r.votes.flatMap(v => v.issues)
  log(`  REJECTED ${r.crate.id} (${r.crate.name}): ${issues.join('; ')}`)
}

// Phase 4: Merge confirmed crate changes in parallel
phase('Merge')
const allChanges = confirmed.flatMap(({ crate, result, votes }) =>
  result.changes.map(change => ({ crate, change, votes, result }))
)

const applied = await parallel(
  allChanges.map(({ crate, change, votes, result }) => async () => {
    const suggestionNotes = votes.map(v => v.suggestion).filter(Boolean).join('; ')
    const prompt = change.isNewFile
      ? `Create a new file at ${change.file} (part of crate: ${crate.name}). Use the Write tool.

Content:
\`\`\`
${change.newCode}
\`\`\`

Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}
Return applied=true and a one-line summary.`
      : `Apply this change to ${change.file} (part of crate: ${crate.name}). Use the Edit tool.

Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}

Replace exactly this code:
\`\`\`
${change.originalCode}
\`\`\`

With:
\`\`\`
${change.newCode}
\`\`\`

Read file back to confirm. Return applied=true and a one-line summary.`

    return agent(prompt, { label: `merge:${crate.id}:${change.file}`, phase: 'Merge', schema: APPLY_SCHEMA })
  })
)

const successes = applied.filter(Boolean).filter(a => a.applied)
const failures = applied.filter(Boolean).filter(a => !a.applied)

return {
  task: decomp.task,
  cratesTotal: decomp.crates.length,
  cratesApproved: confirmed.length,
  cratesRejected: rejected.length,
  filesChanged: allChanges.length,
  filesApplied: successes.length,
  filesFailed: failures.length,
  details: results.filter(Boolean).map(r => ({
    crate: r.crate.id,
    name: r.crate.name,
    files: r.crate.files,
    approved: r.confirmed,
    votes: `${r.approvals}/${r.total}`,
    summary: r.result.summary,
  })),
  appliedSummaries: successes.map(a => a.summary),
}
