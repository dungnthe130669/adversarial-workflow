
export const meta = {
  name: 'adversarial-tests',
  description: 'Spec-driven adversarial test generation: attack surface mapping → parallel test write (spec-only) → dual reviewer gate → run → triage failures',
  phases: [
    { title: 'Fingerprint', detail: 'Detect test framework, extract module manifest (AST)' },
    { title: 'Plan', detail: 'Map attack surface from spec — never from source code' },
    { title: 'Write', detail: 'Parallel agents write tests per module, spec-only context' },
    { title: 'Review', detail: 'Dual adversarial review per test file — bug catcher vs false positive hunter' },
    { title: 'Run', detail: 'Execute approved tests with timeout' },
    { title: 'Triage', detail: 'Classify failures: real_bug / test_wrong / env_issue' },
  ],
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const FINGERPRINT_SCHEMA = {
  type: 'object',
  properties: {
    framework: { type: 'string' },
    runner: { type: 'string' },
    testDir: { type: 'string' },
    configFile: { type: 'string' },
    language: { type: 'string' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          importPath: { type: 'string' },
          exports: { type: 'array', items: { type: 'string' } },
          isAsync: { type: 'boolean' },
        },
        required: ['name', 'importPath', 'exports', 'isAsync'],
      },
    },
    mockLibrary: { type: 'string' },
    scaffoldTemplate: { type: 'string' },
  },
  required: ['framework', 'runner', 'testDir', 'language', 'modules', 'scaffoldTemplate'],
}

const ATTACK_MAP_SCHEMA = {
  type: 'object',
  properties: {
    specQualityScore: { type: 'number' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          specSection: { type: 'string' },
          mustDo: { type: 'array', items: { type: 'string' } },
          mustNotDo: { type: 'array', items: { type: 'string' } },
          boundaries: { type: 'array', items: { type: 'string' } },
          errorCases: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'specSection', 'mustDo', 'mustNotDo', 'boundaries', 'errorCases'],
      },
    },
  },
  required: ['specQualityScore', 'modules'],
}

const TEST_FILE_SCHEMA = {
  type: 'object',
  properties: {
    module: { type: 'string' },
    testCode: { type: 'string' },
    contractsCovered: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          contract: { type: 'string' },
          testName: { type: 'string' },
        },
        required: ['contract', 'testName'],
      },
    },
  },
  required: ['module', 'testCode', 'contractsCovered'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    reviewerRole: { type: 'string', enum: ['bug_catcher', 'false_positive_hunter', 'tiebreaker'] },
    verdict: { type: 'string', enum: ['approve', 'reject', 'needs_revision'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          testName: { type: 'string' },
          issueType: { type: 'string' },
          description: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['testName', 'issueType', 'description', 'suggestedFix'],
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['reviewerRole', 'verdict', 'issues', 'reasoning'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    testId: { type: 'string' },
    module: { type: 'string' },
    classification: { type: 'string', enum: ['real_bug', 'test_wrong', 'env_issue'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'n/a'] },
    reasoning: { type: 'string' },
    specContractViolated: { type: 'string' },
    recommendedAction: { type: 'string' },
  },
  required: ['testId', 'module', 'classification', 'confidence', 'severity', 'reasoning', 'recommendedAction'],
}

// ─── Phase 0: Fingerprint ─────────────────────────────────────────────────────
phase('Fingerprint')

const fingerprint = await agent(
  `Detect the project's test framework and extract a module manifest.

Steps:
1. List files in the project root: package.json, pyproject.toml, go.mod, Cargo.toml, etc.
2. Detect test framework:
   - JS: check package.json scripts.test + devDependencies → jest / vitest / bun / mocha / tap
   - Python: check pyproject.toml [tool.pytest] or setup.cfg → pytest / unittest
   - Go: go test (always)
   - Rust: cargo test (always)
   If undetectable → set framework="unknown", runner="unknown"
3. Find test directory (src/__tests__, test/, tests/, spec/, __tests__)
4. For each source module (non-test file):
   - Extract exported symbols (function names, class names, const names)
   - Detect if exports are async
   - Compute the correct import path relative to the test directory
5. Detect mock library: jest.mock, vi.mock, unittest.mock, etc.
6. Generate a scaffoldTemplate: a minimal test file with correct imports, describe/it structure, async wrappers for this framework

Return structured JSON. If framework is unknown, still return what you found.`,
  { label: 'fingerprint', phase: 'Fingerprint', schema: FINGERPRINT_SCHEMA }
)

if (fingerprint.framework === 'unknown') {
  log('WARNING: Could not detect test framework. Tests may not run correctly.')
} else {
  log(`Framework: ${fingerprint.framework} (${fingerprint.runner})`)
}
log(`Modules found: ${fingerprint.modules.map(m => m.name).join(', ')}`)

// ─── Phase 1: Attack Surface Mapping ─────────────────────────────────────────
phase('Plan')

const specPath = args || './SPEC.md'
const attackMap = await agent(
  `You are a security-minded test architect. Read ONLY the spec at ${specPath}.
DO NOT read any source files. Your job: map the attack surface from intent, not implementation.

For each module described in the spec (cross-reference with these known modules: ${fingerprint.modules.map(m => m.name).join(', ')}):
1. mustDo: what the module MUST do (positive contracts, concrete and testable)
2. mustNotDo: what it MUST NOT do (negative contracts, invariants)
3. boundaries: edge cases, boundary values, limit conditions
4. errorCases: error conditions that must be handled (network fail, null input, empty array, etc.)

SPEC QUALITY GATE: Before returning, score the spec quality from 0-100:
- 0-40: spec is too vague to generate useful tests (missing inputs/outputs/error states)
- 41-70: spec is partial — tests will cover happy path only
- 71-100: spec is concrete enough for full adversarial test coverage

Return the specQualityScore and modules. Do NOT invent contracts not in the spec.`,
  { label: 'attack-surface', phase: 'Plan', schema: ATTACK_MAP_SCHEMA }
)

log(`Spec quality score: ${attackMap.specQualityScore}/100`)
if (attackMap.specQualityScore < 40) {
  log('WARNING: Spec quality too low. Tests may be hallucinated. Consider improving SPEC.md first.')
}
log(`Attack surface mapped: ${attackMap.modules.length} module(s)`)
for (const m of attackMap.modules) {
  log(`  ${m.name}: ${m.mustDo.length} contracts, ${m.boundaries.length} boundaries, ${m.errorCases.length} error cases`)
}

// ─── Phase 2: Write Tests (parallel, spec-only context) ──────────────────────
phase('Write')

// Cap at 16 concurrent agents
const modulesToTest = attackMap.modules.slice(0, 16)

const rawTests = await parallel(
  modulesToTest.map((mod) => async () => {
    const manifest = fingerprint.modules.find(m => m.name === mod.name) || {
      importPath: `./${mod.name}`,
      exports: [],
      isAsync: false,
    }

    return agent(
      `You are writing adversarial tests for module: ${mod.name}

Test framework: ${fingerprint.framework}
Scaffold template to follow EXACTLY for imports and structure:
\`\`\`
${fingerprint.scaffoldTemplate}
\`\`\`

Module import path (use this exactly): ${manifest.importPath}
Exported symbols to test: ${manifest.exports.join(', ') || '(detect from import)'}
Async: ${manifest.isAsync}

Attack surface (from spec — this is your ONLY source of truth):
MUST DO:
${mod.mustDo.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

MUST NOT DO:
${mod.mustNotDo.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

BOUNDARIES:
${mod.boundaries.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}

ERROR CASES:
${mod.errorCases.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}

Rules:
- DO NOT read the implementation source files
- Write tests that would FAIL if any contract above is violated
- Each test must have a comment: // CONTRACT: <which contract this tests>
- Test BEHAVIOR, not internal structure
- Use boundary values, not just happy path
- One test per contract minimum
- Use exact import path and scaffold template above

Return the complete test file as testCode, and list each contract covered.`,
      { label: `write:${mod.name}`, phase: 'Write', schema: TEST_FILE_SCHEMA }
    )
  })
)

const writtenTests = rawTests.filter(Boolean)
log(`Written: ${writtenTests.length} test file(s)`)

// ─── Phase 3: Dual Adversarial Review ────────────────────────────────────────
phase('Review')

const reviewedTests = []

for (const testFile of writtenTests) {
  const mod = attackMap.modules.find(m => m.name === testFile.module) || {}

  const attackSurfaceContext = `
MUST DO: ${(mod.mustDo || []).join('; ')}
MUST NOT DO: ${(mod.mustNotDo || []).join('; ')}
BOUNDARIES: ${(mod.boundaries || []).join('; ')}
ERROR CASES: ${(mod.errorCases || []).join('; ')}
  `.trim()

  // Run Reviewer A and B in parallel
  const [verdictA, verdictB] = await Promise.all([
    agent(
      `You are Reviewer A — THE BUG CATCHER. Your adversarial job: find tests that WON'T catch real bugs.
Default to reject/needs_revision unless tests are genuinely adversarial.

Module: ${testFile.module}
Attack surface:
${attackSurfaceContext}

Test file to review:
\`\`\`
${testFile.testCode}
\`\`\`

For each test, ask:
1. If I deliberately violated the contract this test covers, would it FAIL? If not → 'wont_catch_bug'
2. Is this only testing the happy path when boundaries/error cases exist? → 'missing_boundary'
3. Is the assertion so weak it passes with wrong output? → 'under_specified'
4. Could a completely WRONG implementation still pass? → 'tautological'

Also check: are there attack surface contracts with NO test covering them? List them.

Be brutal. False confidence is worse than no tests.`,
      { label: `review-A:${testFile.module}`, phase: 'Review', schema: VERDICT_SCHEMA }
    ),
    agent(
      `You are Reviewer B — THE FALSE POSITIVE HUNTER. Your adversarial job: find tests that fail for the WRONG reasons.
Default to reject/needs_revision unless tests are behavior-focused and refactor-safe.

Module: ${testFile.module}
Attack surface:
${attackSurfaceContext}

Test file to review:
\`\`\`
${testFile.testCode}
\`\`\`

For each test, ask:
1. Does it assert internal implementation details (call order, internal state, private methods)? → 'tests_implementation_not_behavior'
2. Would it break if someone CORRECTLY refactored the impl? → 'over_specified'
3. Are mocks/stubs so tight they'll fail on correct alternative implementations? → 'false_positive_risk'
4. Does it depend on timing, environment, or external state? → 'env_dependency'
5. Does it seem written to match a specific (possibly broken) implementation rather than the spec? → 'tautological'

Remember: we want tests that survive correct refactors but catch real bugs.`,
      { label: `review-B:${testFile.module}`, phase: 'Review', schema: VERDICT_SCHEMA }
    )
  ])

  // Reconcile verdicts
  const bothApprove = verdictA.verdict === 'approve' && verdictB.verdict === 'approve'
  const eitherReject = verdictA.verdict === 'reject' || verdictB.verdict === 'reject'
  const disagree = verdictA.verdict !== verdictB.verdict

  let finalVerdict
  let finalCode = testFile.testCode

  if (bothApprove) {
    finalVerdict = 'approved'
  } else if (disagree) {
    // Tiebreaker agent
    const tiebreaker = await agent(
      `You are a senior test architect. Two reviewers disagree on this test file.

Module: ${testFile.module}

Reviewer A (Bug Catcher) verdict: ${verdictA.verdict}
Issues: ${verdictA.issues.map(i => i.description).join('; ')}

Reviewer B (False Positive Hunter) verdict: ${verdictB.verdict}
Issues: ${verdictB.issues.map(i => i.description).join('; ')}

Test file:
\`\`\`
${finalCode}
\`\`\`

Your job: make the final call. Weigh both critiques. 
- If Reviewer A's bugs are real (tests genuinely miss bugs) → approve Reviewer A, reject B's concern
- If Reviewer B's false positives are real (tests will break on correct refactors) → approve B
- If both are right → needs_revision with specific fixes

Return your verdict.`,
      { label: `tiebreaker:${testFile.module}`, phase: 'Review', schema: VERDICT_SCHEMA }
    )
    finalVerdict = tiebreaker.verdict === 'approve' ? 'approved' : 'needs_revision'
    log(`  Tiebreaker for ${testFile.module}: ${finalVerdict}`)
  } else if (eitherReject) {
    finalVerdict = 'rejected'
  } else {
    // Both need_revision — attempt one revision
    const allIssues = [...verdictA.issues, ...verdictB.issues]
    const revised = await agent(
      `Revise this test file to fix all review issues. Keep the spec contracts — only fix the test quality issues.

Module: ${testFile.module}
Original test file:
\`\`\`
${finalCode}
\`\`\`

Issues to fix:
${allIssues.map(i => `- [${i.issueType}] ${i.testName}: ${i.description} → Fix: ${i.suggestedFix}`).join('\n')}

Attack surface (contracts to keep):
${attackSurfaceContext}

Return the revised testCode and updated contractsCovered.`,
      { label: `revise:${testFile.module}`, phase: 'Review', schema: TEST_FILE_SCHEMA }
    )
    finalCode = revised?.testCode || finalCode
    finalVerdict = 'approved' // give revised version benefit of doubt
    log(`  Revised ${testFile.module} — 1 revision applied`)
  }

  log(`  ${testFile.module}: ${finalVerdict} (A:${verdictA.verdict} B:${verdictB.verdict})`)
  reviewedTests.push({ ...testFile, testCode: finalCode, status: finalVerdict })
}

const approved = reviewedTests.filter(t => t.status === 'approved')
const rejected = reviewedTests.filter(t => t.status !== 'approved')
log(`Review complete: ${approved.length} approved, ${rejected.length} rejected/needs-revision`)

// ─── Phase 4: Write test files + Run ─────────────────────────────────────────
phase('Run')

const testRunResult = await agent(
  `Write and run the approved test files.

Test framework: ${fingerprint.framework}
Runner command: ${fingerprint.runner}
Test directory: ${fingerprint.testDir}

For each test file below:
1. Write the file to ${fingerprint.testDir}/<module>.test.${fingerprint.language === 'python' ? 'py' : 'ts'}
2. After writing all files, run: ${fingerprint.runner} with a 60-second timeout
3. Collect pass/fail/error per test with full output

Test files to write:
${approved.map(t => `\n=== ${t.module} ===\n${t.testCode}`).join('\n\n')}

Return the raw test runner output. Include all pass/fail/skip counts.
If the runner fails to start (config error, framework not installed), report that separately.`,
  { label: 'run-tests', phase: 'Run' }
)

log(`Test run complete`)

// ─── Phase 5: Triage Failures ─────────────────────────────────────────────────
phase('Triage')

const triage = await agent(
  `You are triaging test failures. For each failed test, classify: real_bug / test_wrong / env_issue.

Test run output:
${typeof testRunResult === 'string' ? testRunResult : JSON.stringify(testRunResult)}

Attack surface (spec contracts):
${attackMap.modules.map(m =>
  `${m.name}:\n  MUST DO: ${m.mustDo.join('; ')}\n  ERROR CASES: ${m.errorCases.join('; ')}`
).join('\n\n')}

Test files that ran:
${approved.map(t => `=== ${t.module} ===\n${t.testCode}`).join('\n\n')}

For each FAILING test:
- real_bug: implementation violates a spec contract. Cite the exact contract violated.
- test_wrong: test assertion is wrong, test setup is wrong, or test misread the spec.
- env_issue: failure due to missing setup, wrong config, external dependency, timing.

Classify each failure. For real_bug: severity (critical/high/medium/low).
For low confidence (<70%): say so explicitly — human should review.

Also count: total passed, total failed, by classification.`,
  { label: 'triage-failures', phase: 'Triage' }
)

return {
  framework: fingerprint.framework,
  specQualityScore: attackMap.specQualityScore,
  modulesScanned: attackMap.modules.length,
  testFilesWritten: writtenTests.length,
  testFilesApproved: approved.length,
  testFilesRejected: rejected.length,
  triage: triage,
}
