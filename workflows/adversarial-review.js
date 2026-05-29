
export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial PR review: 4 specialist attackers (logic, security, perf, regression) → triage → MUST_FIX/SHOULD_FIX/CONSIDER → post to GitHub PR',
  phases: [
    { title: 'Diff', detail: 'Extract git diff, chunk by file' },
    { title: 'Attack', detail: '4 specialist reviewers in parallel — logic, security, perf, regression' },
    { title: 'Triage', detail: 'Deduplicate, classify MUST_FIX / SHOULD_FIX / CONSIDER' },
    { title: 'Deliver', detail: 'Post inline comments to GitHub PR, block merge if MUST_FIX exists' },
  ],
}

const DIFF_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    baseBranch: { type: 'string' },
    prNumber: { type: 'string' },
    chunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          language: { type: 'string' },
          additions: { type: 'number' },
          deletions: { type: 'number' },
          diff: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['file', 'language', 'additions', 'deletions', 'diff', 'context'],
      },
    },
    totalFiles: { type: 'number' },
    totalAdditions: { type: 'number' },
    totalDeletions: { type: 'number' },
  },
  required: ['branch', 'baseBranch', 'chunks', 'totalFiles', 'totalAdditions', 'totalDeletions'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
          confidence: { type: 'string', enum: ['confirmed', 'suspected', 'dismissed'] },
        },
        required: ['file', 'line', 'severity', 'title', 'description', 'suggestion', 'confidence'],
      },
    },
  },
  required: ['angle', 'findings'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    mustFix: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
          angle: { type: 'string' },
        },
        required: ['file', 'line', 'title', 'description', 'suggestion', 'angle'],
      },
    },
    shouldFix: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
          angle: { type: 'string' },
        },
        required: ['file', 'line', 'title', 'description', 'suggestion', 'angle'],
      },
    },
    consider: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['file', 'line', 'title', 'description', 'suggestion'],
      },
    },
    summary: { type: 'string' },
    approved: { type: 'boolean' },
  },
  required: ['mustFix', 'shouldFix', 'consider', 'summary', 'approved'],
}

// Phase 1: Extract diff, chunk by file
phase('Diff')

// Parse args: could be PR number, branch name, or empty (current branch vs main)
const target = args || ''
const isPR = /^\d+$/.test(target.trim())
const isBranch = target && !isPR

const diffInfo = await agent(
  `Extract the git diff for review. ${
    isPR
      ? `PR number: ${target}. Run: gh pr diff ${target} --patch`
      : isBranch
      ? `Branch: ${target}. Run: git diff origin/main...${target}`
      : `Current branch vs main. Run: git diff origin/main...HEAD`
  }

Steps:
1. Run the diff command above
2. Also run: git rev-parse --abbrev-ref HEAD (to get branch name)
3. If PR number given, run: gh pr view ${isPR ? target : 'HEAD'} --json number (to get PR number)
4. Split the diff into per-file chunks — each chunk = one file's changes
5. For each chunk: extract file path, language (from extension), additions count, deletions count, the raw diff, and a one-line context summary
6. Skip binary files, lock files (package-lock.json, yarn.lock, Cargo.lock), and generated files

Return structured JSON. Keep each chunk's diff under 4000 chars — if a file diff is longer, include the most changed sections and note truncation in context.`,
  { label: 'extract-diff', phase: 'Diff', schema: DIFF_SCHEMA }
)

const { chunks, totalFiles, totalAdditions, totalDeletions } = diffInfo
log(`Diff: ${totalFiles} file(s), +${totalAdditions}/-${totalDeletions} lines`)
log(`Chunks: ${chunks.map(c => c.file).join(', ')}`)

if (chunks.length === 0) {
  log('No changes to review.')
  return { approved: true, mustFix: 0, shouldFix: 0, consider: 0, summary: 'No changes found.' }
}

// Phase 2: 4 specialist attackers in parallel
phase('Attack')

const diffContext = chunks.map(c =>
  `=== ${c.file} (${c.language}, +${c.additions}/-${c.deletions}) ===\n${c.diff}`
).join('\n\n')

const [logicFindings, securityFindings, perfFindings, regressionFindings] = await Promise.all([
  agent(
    `You are an adversarial code reviewer — LOGIC ATTACKER.
Your job: find logic errors, incorrect assumptions, and missed edge cases in this diff.
Be brutal. Default to reporting if you're unsure — the triage agent will filter false positives.

Diff to review:
${diffContext}

Hunt for:
- Incorrect logic (wrong operator, wrong condition, wrong algorithm)
- Off-by-one errors (loop bounds, array indices, pagination)
- Missing null/undefined checks
- Wrong assumptions about input types or ranges
- Missed error cases (what if the network fails? what if the array is empty?)
- Race conditions in async code (missing await, unhandled promise rejection)
- State mutation bugs (modifying shared state, incorrect clone)
- Incorrect boolean logic (wrong && vs ||, negation errors)

For each finding:
- file: which file
- line: approximate line range from the diff (e.g. "45-52")
- severity: blocker (will cause incorrect behavior) / major (likely edge case bug) / minor (code smell)
- confidence: confirmed (definitely wrong) / suspected (probably wrong) / dismissed (flag but low confidence)
- title: one-line description
- description: why this is wrong, what will happen
- suggestion: how to fix it

IMPORTANT: Only review code in the diff. Do not flag things outside the changed lines.`,
    { label: 'attack-logic', phase: 'Attack', schema: FINDINGS_SCHEMA }
  ),

  agent(
    `You are an adversarial code reviewer — SECURITY ATTACKER.
Your job: find security vulnerabilities in this diff.
Be brutal. Default to reporting if unsure — the triage agent filters false positives.

Diff to review:
${diffContext}

Hunt for:
- Injection (SQL, command, LDAP, XPath, template injection)
- Authentication/authorization bypass (missing auth checks, privilege escalation)
- Insecure direct object references (IDOR — accessing resources by raw user-supplied ID)
- Missing input validation (accepting arbitrary user data without sanitization)
- Sensitive data exposure (logging secrets, PII in errors, stack traces in responses)
- Insecure cryptography (MD5, SHA1 for passwords, weak random, hardcoded keys/secrets)
- Path traversal (user-controlled file paths without normalization)
- XSS (unescaped user input in HTML/JS contexts)
- CSRF (missing tokens on state-changing endpoints)
- Dependency confusion or import hijacking

For each finding:
- file: which file
- line: approximate line range from diff
- severity: blocker (exploitable now) / major (exploitable with attacker effort) / minor (defense in depth)
- confidence: confirmed / suspected / dismissed
- title, description, suggestion

IMPORTANT: Only flag code in the diff. Do not flag pre-existing issues outside changed lines.`,
    { label: 'attack-security', phase: 'Attack', schema: FINDINGS_SCHEMA }
  ),

  agent(
    `You are an adversarial code reviewer — PERFORMANCE ATTACKER.
Your job: find performance regressions introduced by this diff.
Only flag things that are MEASURABLY worse, not theoretical micro-optimizations.

Diff to review:
${diffContext}

Hunt for:
- O(n²) or worse complexity where O(n) or O(log n) was possible (nested loops over same data)
- N+1 query patterns (DB/API call inside a loop)
- Unnecessary re-computation in hot paths (recomputing inside render, inside loop)
- Blocking I/O in async context (sync file read, sync crypto)
- Memory leaks (event listeners never removed, caches never evicted, closures holding large objects)
- Unnecessary serialization/deserialization in tight loops (JSON.parse inside loop)
- Missing indexes implied by new query patterns
- Large payloads transferred unnecessarily (fetching full objects when only ID needed)

For each finding:
- file, line, severity, confidence, title, description, suggestion

severity: blocker (will cause timeouts/OOM at load) / major (noticeable under realistic load) / minor (negligible)
IMPORTANT: Only flag code in the diff. Skip theoretical optimizations — only flag measurable regressions.`,
    { label: 'attack-perf', phase: 'Attack', schema: FINDINGS_SCHEMA }
  ),

  agent(
    `You are an adversarial code reviewer — REGRESSION ATTACKER.
Your job: find ways this diff silently breaks existing behavior that callers depend on.

Diff to review:
${diffContext}

Hunt for:
- Changed function signatures (added required param, changed param order, changed return type)
- Changed error behavior (used to throw, now returns null — callers that check !== null break)
- Changed data shapes (renamed field, removed field, changed type of field)
- Changed side effects (used to write a file, now doesn't — callers depended on that file)
- Changed event emission (renamed event, removed event, changed event payload)
- Removed exports (callers importing the removed name get runtime errors)
- Changed HTTP API shapes (response field renamed, status code changed)
- Database schema changes without migration (column renamed, type changed)
- Changed defaults (default value changed — callers relying on old default break silently)

For each finding:
- file, line, severity, confidence, title, description, suggestion

severity: blocker (definitely breaks callers) / major (probably breaks callers) / minor (might break some callers)
IMPORTANT: Only flag changes in the diff. Note: you may not see the callers — flag suspected breaks as 'suspected'.`,
    { label: 'attack-regression', phase: 'Attack', schema: FINDINGS_SCHEMA }
  ),
])

const allFindings = [logicFindings, securityFindings, perfFindings, regressionFindings].filter(Boolean)
const totalFindings = allFindings.reduce((sum, f) => sum + f.findings.length, 0)
log(`Attack complete: ${totalFindings} finding(s) across ${allFindings.length} angles`)
for (const af of allFindings) {
  const confirmed = af.findings.filter(f => f.confidence === 'confirmed').length
  log(`  ${af.angle}: ${af.findings.length} finding(s), ${confirmed} confirmed`)
}

// Phase 3: Triage — deduplicate, classify, filter false positives
phase('Triage')

const findingsDump = allFindings.map(af =>
  `=== ${af.angle.toUpperCase()} FINDINGS ===\n` +
  af.findings.map(f =>
    `[${f.confidence.toUpperCase()}] [${f.severity}] ${f.file}:${f.line}\n` +
    `Title: ${f.title}\n` +
    `Description: ${f.description}\n` +
    `Suggestion: ${f.suggestion}`
  ).join('\n\n')
).join('\n\n')

const triage = await agent(
  `You are a senior engineer triaging adversarial code review findings. Be fair but rigorous.

Findings from 4 specialist reviewers:
${findingsDump}

Your job:
1. DEDUPLICATE — merge findings that refer to the same issue (different reviewers often catch the same bug)
2. FILTER — remove 'dismissed' confidence findings unless multiple reviewers flagged the same issue
3. CLASSIFY into three buckets:
   - MUST_FIX: blockers or confirmed major findings. PR should NOT merge until these are addressed.
   - SHOULD_FIX: suspected majors or confirmed minors. Should be fixed soon, not blocking merge.
   - CONSIDER: low-confidence or minor findings. Good to know, not required.
4. approved = true only if mustFix array is empty
5. Write a 2-3 sentence summary of the overall PR quality

Rules:
- If only 1 reviewer flagged something as 'suspected', classify as CONSIDER (not MUST_FIX)
- If 2+ reviewers flagged the same issue independently, escalate one level (suspected → confirmed)
- Security blockers are always MUST_FIX regardless of confidence
- Do NOT add findings that weren't in the input — only triage what exists

Return raw JSON only.`,
  { label: 'triage-findings', phase: 'Triage', schema: TRIAGE_SCHEMA }
)

log(`Triage: ${triage.mustFix.length} MUST_FIX, ${triage.shouldFix.length} SHOULD_FIX, ${triage.consider.length} CONSIDER`)
log(`Approved: ${triage.approved}`)

// Phase 4: Deliver — post to GitHub PR or write REVIEW.md
phase('Deliver')

const prNum = diffInfo.prNumber || (isPR ? target : null)

const reviewContent = `# Adversarial Code Review

**Branch:** ${diffInfo.branch || 'unknown'} → ${diffInfo.baseBranch || 'main'}
**Files:** ${totalFiles} | **Changes:** +${totalAdditions}/-${totalDeletions}
**Verdict:** ${triage.approved ? '✅ APPROVED' : '❌ BLOCKED — MUST_FIX items exist'}

${triage.summary}

---

${triage.mustFix.length > 0 ? `## 🚨 MUST FIX (${triage.mustFix.length})

${triage.mustFix.map(f => `### ${f.file}:${f.line} — ${f.title}
**Angle:** ${f.angle}
${f.description}
**Fix:** ${f.suggestion}
`).join('\n')}` : '## ✅ No blockers\n'}

${triage.shouldFix.length > 0 ? `## ⚠️ SHOULD FIX (${triage.shouldFix.length})

${triage.shouldFix.map(f => `### ${f.file}:${f.line} — ${f.title}
${f.description}
**Suggestion:** ${f.suggestion}
`).join('\n')}` : ''}

${triage.consider.length > 0 ? `## 💡 CONSIDER (${triage.consider.length})

${triage.consider.map(f => `- **${f.file}:${f.line}** ${f.title} — ${f.suggestion}`).join('\n')}` : ''}
`

await agent(
  `Write a code review. Do the following:

1. Write this content to REVIEW.md in the current directory:
\`\`\`
${reviewContent}
\`\`\`

2. ${prNum
    ? `Post a review comment to GitHub PR #${prNum} using gh CLI:
   Run: gh pr review ${prNum} --comment --body "[paste the REVIEW.md summary]"
   Then for each MUST_FIX item, post an inline comment:
   Run: gh pr comment ${prNum} --body "[item details]"
   If gh CLI is not available or not authenticated, skip this step and note it.`
    : `No PR number detected. Skip GitHub posting. Just write REVIEW.md.`
  }

3. Print a final summary of what was done.`,
  { label: 'deliver-review', phase: 'Deliver' }
)

return {
  branch: diffInfo.branch,
  filesReviewed: totalFiles,
  findingsTotal: totalFindings,
  mustFix: triage.mustFix.length,
  shouldFix: triage.shouldFix.length,
  consider: triage.consider.length,
  approved: triage.approved,
  summary: triage.summary,
  prPosted: !!prNum,
  reviewFile: 'REVIEW.md',
}
