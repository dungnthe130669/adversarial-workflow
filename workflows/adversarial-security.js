
export const meta = {
  name: 'adversarial-security',
  description: 'Scan codebase for security vulnerabilities, propose fixes, adversarially verify, apply confirmed patches',
  phases: [
    { title: 'Scan', detail: 'Find security vulnerabilities' },
    { title: 'Patch', detail: 'Propose security patches' },
    { title: 'Verify', detail: 'Adversarially challenge each patch' },
    { title: 'Apply', detail: 'Apply confirmed patches' },
  ],
}

const VULNS_SCHEMA = {
  type: 'object',
  properties: {
    vulnerabilities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          description: { type: 'string' },
          attackVector: { type: 'string' },
        },
        required: ['id', 'title', 'file', 'severity', 'category', 'description', 'attackVector'],
      },
    },
  },
  required: ['vulnerabilities'],
}

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    vulnId: { type: 'string' },
    file: { type: 'string' },
    originalCode: { type: 'string' },
    patchedCode: { type: 'string' },
    explanation: { type: 'string' },
    mitigates: { type: 'string' },
  },
  required: ['vulnId', 'file', 'originalCode', 'patchedCode', 'explanation', 'mitigates'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    vulnId: { type: 'string' },
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['vulnId', 'approved', 'issues', 'suggestion'],
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

// Phase 1: Security scan
phase('Scan')
const targetPath = args || '.'
const scan = await agent(
  `You are a security engineer. Scan the codebase at ${targetPath} for security vulnerabilities.

Focus on:
- SQL/NoSQL injection
- XSS (cross-site scripting)
- Authentication/authorization bypass
- Insecure deserialization
- Path traversal
- Command injection
- Hardcoded secrets/credentials
- Insecure direct object references
- Missing input validation
- Insecure cryptography

For each vulnerability found: assign a short id (e.g. "vuln1"), title, file path, severity (critical/high/medium/low), category, description of the vulnerability, and the attack vector (how an attacker would exploit it).

Only report real vulnerabilities with concrete evidence from the code. Do not hallucinate issues.
Return raw JSON only.`,
  { label: 'security-scan', phase: 'Scan', schema: VULNS_SCHEMA }
)

log(`Found ${scan.vulnerabilities.length} vulnerability(s)`)
for (const v of scan.vulnerabilities) {
  log(`  [${v.severity.toUpperCase()}] ${v.id}: ${v.title} in ${v.file}`)
}

// Phase 2 + 3: Patch then verify
const results = await pipeline(
  scan.vulnerabilities,
  // Stage 1: propose patch
  async (vuln) => {
    const patch = await agent(
      `You are a security engineer. Patch this vulnerability with minimal, targeted changes.

Vuln ID: ${vuln.id}
Title: ${vuln.title}
File: ${vuln.file}
Severity: ${vuln.severity}
Category: ${vuln.category}
Description: ${vuln.description}
Attack vector: ${vuln.attackVector}

Steps:
1. Read the file at ${vuln.file}
2. Locate the vulnerable code
3. Write the minimal secure patch — do not refactor unrelated code
4. Return originalCode (exact lines to replace) and patchedCode (secure replacement)

The patch must fully mitigate the attack vector.`,
      { label: `patch:${vuln.id}`, phase: 'Patch', schema: PATCH_SCHEMA }
    )
    return { vuln, patch }
  },
  // Stage 2: adversarial security review — 2 independent skeptics
  async ({ vuln, patch }) => {
    const [skeptic1, skeptic2] = await Promise.all([
      agent(
        `You are an adversarial security reviewer. Your job: find ways the proposed patch FAILS to fix the vulnerability.
Default to approved=false unless you are certain the patch fully mitigates the attack vector.

Vulnerability: ${vuln.description}
Attack vector: ${vuln.attackVector}
File: ${patch.file}

Original (vulnerable) code:
\`\`\`
${patch.originalCode}
\`\`\`

Proposed patch:
\`\`\`
${patch.patchedCode}
\`\`\`

Reviewer angle: Does the patch fully close the attack vector? Bypass? Edge cases?
Can an attacker still exploit this with crafted input, race condition, or encoding tricks?`,
        { label: `verify-mitigation:${vuln.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      ),
      agent(
        `You are an adversarial security reviewer. Your job: find regressions or new vulnerabilities introduced by the patch.
Default to approved=false unless the patch is clearly safe.

Vulnerability: ${vuln.description}
File: ${patch.file}

Original code:
\`\`\`
${patch.originalCode}
\`\`\`

Proposed patch:
\`\`\`
${patch.patchedCode}
\`\`\`

Reviewer angle: Does the patch break functionality? Introduce new bugs? Create new attack surface?
Does it handle all input types correctly? Does it break existing callers?`,
        { label: `verify-regressions:${vuln.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
      )
    ])
    const votes = [skeptic1, skeptic2].filter(Boolean)
    const approvals = votes.filter(v => v.approved).length
    const confirmed = approvals >= Math.ceil(votes.length / 2)
    return { vuln, patch, votes, confirmed, approvals, total: votes.length }
  }
)

const confirmed = results.filter(Boolean).filter(r => r.confirmed)
const rejected = results.filter(Boolean).filter(r => !r.confirmed)

log(`Security review complete: ${confirmed.length} patch(es) approved, ${rejected.length} need rework`)
for (const r of rejected) {
  const issues = r.votes.flatMap(v => v.issues)
  log(`  REJECTED ${r.vuln.id} [${r.vuln.severity}]: ${issues.join('; ')}`)
}

// Phase 4: Apply confirmed patches
phase('Apply')
const applied = await parallel(
  confirmed.map(({ vuln, patch, votes }) => async () => {
    const suggestionNotes = votes.map(v => v.suggestion).filter(Boolean).join('; ')
    return agent(
      `Apply this security patch to the file. Use the Edit tool.

File: ${patch.file}
Vulnerability fixed: ${vuln.title} (${vuln.severity})
Reviewer suggestions (incorporate if relevant): ${suggestionNotes || 'none'}

Replace exactly this code:
\`\`\`
${patch.originalCode}
\`\`\`

With:
\`\`\`
${patch.patchedCode}
\`\`\`

Read the file back to confirm the patch is in place.
Return applied=true if succeeded, false otherwise, and a one-line summary.`,
      { label: `apply:${vuln.id}`, phase: 'Apply', schema: APPLY_SCHEMA }
    )
  })
)

const successes = applied.filter(Boolean).filter(a => a.applied)
const failures = applied.filter(Boolean).filter(a => !a.applied)

return {
  vulnsFound: scan.vulnerabilities.length,
  patchesApproved: confirmed.length,
  patchesRejected: rejected.length,
  patchesApplied: successes.length,
  patchesFailed: failures.length,
  bySeverity: {
    critical: scan.vulnerabilities.filter(v => v.severity === 'critical').length,
    high: scan.vulnerabilities.filter(v => v.severity === 'high').length,
    medium: scan.vulnerabilities.filter(v => v.severity === 'medium').length,
    low: scan.vulnerabilities.filter(v => v.severity === 'low').length,
  },
  details: results.filter(Boolean).map(r => ({
    vuln: r.vuln.id,
    title: r.vuln.title,
    severity: r.vuln.severity,
    approved: r.confirmed,
    votes: `${r.approvals}/${r.total}`,
  })),
  appliedSummaries: successes.map(a => a.summary),
}
