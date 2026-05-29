
export const meta = {
  name: 'adversarial-feature',
  description: 'Plan a feature, implement it, adversarially review implementation, apply approved changes',
  phases: [
    { title: 'Plan', detail: 'Break feature spec into tasks' },
    { title: 'Implement', detail: 'Implement each task' },
    { title: 'Review', detail: 'Adversarial code review of each implementation' },
    { title: 'Apply', detail: 'Apply approved implementations' },
  ],
}

const TASKS_SCHEMA = {
  type: 'object',
  properties: {
    featureName: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'string' },
        },
        required: ['id', 'title', 'file', 'description', 'acceptance'],
      },
    },
  },
  required: ['featureName', 'tasks'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    file: { type: 'string' },
    originalCode: { type: 'string' },
    newCode: { type: 'string' },
    explanation: { type: 'string' },
    isNewFile: { type: 'boolean' },
  },
  required: ['taskId', 'file', 'originalCode', 'newCode', 'explanation', 'isNewFile'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['taskId', 'approved', 'issues', 'suggestion'],
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

// Phase 1: Plan
phase('Plan')
const specPath = args || './FEATURE.md'
const plan = await agent(
  `Read the feature spec at ${specPath} and break it into concrete implementation tasks.
For each task provide: a short id (e.g. "task1"), title, the file to modify/create, description of what to do, and acceptance criteria.
Return raw JSON only.`,
  { label: 'plan-feature', phase: 'Plan', schema: TASKS_SCHEMA }
)

log(`Feature: ${plan.featureName} — ${plan.tasks.length} task(s): ${plan.tasks.map(t => t.title).join(', ')}`)

// Phase 2 + 3: Implement then adversarially review
const results = await pipeline(
  plan.tasks,
  // Stage 1: implement
  async (task) => {
    const impl = await agent(
      `You are a careful software engineer implementing a feature task.

Task ID: ${task.id}
Title: ${task.title}
File: ${task.file}
Description: ${task.description}
Acceptance criteria: ${task.acceptance}

Steps:
1. If the file exists, read it first using the Read tool
2. Write minimal, clean code that satisfies the acceptance criteria
3. If new file: set isNewFile=true, originalCode=""
4. If modifying: set originalCode to the exact lines being replaced
5. Return newCode as the complete replacement or new file content

Do not add unnecessary abstractions. Match existing code style.`,
      { label: `impl:${task.id}`, phase: 'Implement', schema: IMPL_SCHEMA }
    )
    return { task, impl }
  },
  // Stage 2: adversarial review — 2 independent reviewers
  async ({ task, impl }) => {
    const [reviewer1, reviewer2] = await Promise.all([
      agent(
        `You are an adversarial code reviewer focused on correctness.
Default to approved=false unless the implementation clearly satisfies ALL acceptance criteria.

Task: ${task.description}
Acceptance criteria: ${task.acceptance}
File: ${impl.file}

Implementation:
\`\`\`
${impl.newCode}
\`\`\`

Check:
- Does it satisfy ALL acceptance criteria?
- Edge cases and null checks?
- Security issues (injection, auth, validation)?
- Are imports/dependencies correct?`,
        { label: `review-correctness:${task.id}`, phase: 'Review', schema: REVIEW_SCHEMA }
      ),
      agent(
        `You are an adversarial code reviewer focused on architecture and regressions.
Default to approved=false unless the implementation is clearly safe and well-structured.

Task: ${task.description}
Acceptance criteria: ${task.acceptance}
File: ${impl.file}

Implementation:
\`\`\`
${impl.newCode}
\`\`\`

Check:
- Does it break existing callers or APIs?
- Is it consistent with the codebase style?
- Performance concerns?
- Does it introduce duplication or tech debt?`,
        { label: `review-architecture:${task.id}`, phase: 'Review', schema: REVIEW_SCHEMA }
      )
    ])
    const votes = [reviewer1, reviewer2].filter(Boolean)
    const approvals = votes.filter(v => v.approved).length
    const confirmed = approvals >= Math.ceil(votes.length / 2)
    return { task, impl, votes, confirmed, approvals, total: votes.length }
  }
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected = results.filter(Boolean).filter(r => !r.confirmed)

log(`Review complete: ${confirmed.length} task(s) approved, ${rejected.length} rejected`)
for (const r of rejected) {
  const issues = r.votes.flatMap(v => v.issues)
  log(`  REJECTED ${r.task.id}: ${issues.join('; ')}`)
}

// Phase 4: Apply approved implementations
phase('Apply')
const applied = await parallel(
  confirmed.map(({ task, impl, votes }) => async () => {
    const suggestionNotes = votes.map(v => v.suggestion).filter(Boolean).join('; ')
    const prompt = impl.isNewFile
      ? `Create a new file at ${impl.file} with this content. Use the Write tool.

Content:
\`\`\`
${impl.newCode}
\`\`\`

Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}
Return applied=true and a one-line summary.`
      : `Apply this implementation to the file. Use the Edit tool.

File: ${impl.file}
Task: ${task.title}
Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}

Replace exactly this code:
\`\`\`
${impl.originalCode}
\`\`\`

With:
\`\`\`
${impl.newCode}
\`\`\`

Read the file back to confirm. Return applied=true and a one-line summary.`

    return agent(prompt, { label: `apply:${task.id}`, phase: 'Apply', schema: APPLY_SCHEMA })
  })
)

const successes = applied.filter(Boolean).filter(a => a.applied)
const failures = applied.filter(Boolean).filter(a => !a.applied)

return {
  feature: plan.featureName,
  tasksPlanned: plan.tasks.length,
  tasksApproved: confirmed.length,
  tasksRejected: rejected.length,
  tasksApplied: successes.length,
  tasksFailed: failures.length,
  details: results.filter(Boolean).map(r => ({
    task: r.task.id,
    title: r.task.title,
    approved: r.confirmed,
    votes: `${r.approvals}/${r.total}`,
  })),
  appliedSummaries: successes.map(a => a.summary),
}
