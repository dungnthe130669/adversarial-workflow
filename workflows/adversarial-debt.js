/**
 * adversarial-debt.js
 * Claude Code Workflow: Adversarial Technical Debt Elimination
 *
 * Scope: dead code + duplicated logic ONLY
 * Output: actionable GitHub issues (not reports)
 * Method: Agent A defends keeping, Agent B argues deletion
 * Auto-apply: deletions where BOTH agents agree, zero callers confirmed
 * Measure: lines deleted, complexity delta — fail if complexity UP
 *
 * @joshkeldam principle: deletion is first-class outcome
 */

const { agent, pipeline, parallel, phase, log } = require("./workflow-primitives");

// ─── Schemas ────────────────────────────────────────────────────────────────

const DEAD_CODE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique finding ID, e.g. DC-001" },
    kind: {
      type: "string",
      enum: ["dead_function", "dead_class", "dead_variable", "dead_export", "dead_import"],
      description: "Category of dead code",
    },
    file: { type: "string", description: "Relative file path" },
    line_start: { type: "number" },
    line_end: { type: "number" },
    symbol: { type: "string", description: "Name of the symbol" },
    caller_count: { type: "number", description: "Confirmed call/reference count (0 = dead)" },
    evidence: { type: "string", description: "How caller_count was determined (grep, AST, etc.)" },
    lines: { type: "number", description: "Lines of code this finding spans" },
  },
  required: ["id", "kind", "file", "line_start", "line_end", "symbol", "caller_count", "evidence", "lines"],
};

const DUPE_LOGIC_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unique finding ID, e.g. DL-001" },
    kind: { type: "string", enum: ["duplicated_function", "duplicated_block", "near_duplicate"] },
    files: {
      type: "array",
      items: { type: "string" },
      description: "Files containing duplicates",
    },
    symbols: {
      type: "array",
      items: { type: "string" },
    },
    similarity_pct: { type: "number", description: "0-100 similarity percentage" },
    total_lines: { type: "number", description: "Total duplicated lines (all copies)" },
    deletable_lines: { type: "number", description: "Lines that can be deleted (keep one copy)" },
    evidence: { type: "string" },
  },
  required: ["id", "kind", "files", "symbols", "similarity_pct", "total_lines", "deletable_lines", "evidence"],
};

const SCAN_RESULTS_SCHEMA = {
  type: "object",
  properties: {
    repo_path: { type: "string" },
    languages: { type: "array", items: { type: "string" } },
    total_files_scanned: { type: "number" },
    total_lines_scanned: { type: "number" },
    dead_code: { type: "array", items: DEAD_CODE_ITEM_SCHEMA },
    duplicated_logic: { type: "array", items: DUPE_LOGIC_ITEM_SCHEMA },
    baseline_complexity: {
      type: "object",
      properties: {
        cyclomatic_total: { type: "number" },
        method: { type: "string" },
      },
    },
  },
  required: ["repo_path", "languages", "total_files_scanned", "total_lines_scanned", "dead_code", "duplicated_logic", "baseline_complexity"],
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    defender_verdict: {
      type: "string",
      enum: ["keep", "unsure", "delete_ok"],
      description: "Agent A: keep=load-bearing/hidden-cost, delete_ok=safe to remove",
    },
    defender_reasoning: { type: "string" },
    attacker_verdict: {
      type: "string",
      enum: ["delete", "unsure", "keep"],
      description: "Agent B: delete=should go, keep=actually needed",
    },
    attacker_reasoning: { type: "string" },
    consensus: {
      type: "string",
      enum: ["auto_delete", "manual_review", "keep"],
      description: "auto_delete: both agree safe. manual_review: disagreement. keep: both agree keep.",
    },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["finding_id", "defender_verdict", "defender_reasoning", "attacker_verdict", "attacker_reasoning", "consensus", "risk_level"],
};

const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: { type: "array", items: VERDICT_SCHEMA },
  },
  required: ["verdicts"],
};

const DELETION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    applied: { type: "boolean" },
    lines_deleted: { type: "number" },
    files_modified: { type: "array", items: { type: "string" } },
    diff_summary: { type: "string" },
    error: { type: "string" },
  },
  required: ["finding_id", "applied", "lines_deleted", "files_modified"],
};

const COMPLEXITY_DELTA_SCHEMA = {
  type: "object",
  properties: {
    before: { type: "number" },
    after: { type: "number" },
    delta: { type: "number", description: "Negative = complexity reduced (good)" },
    passed: { type: "boolean", description: "true if delta <= 0" },
    method: { type: "string" },
  },
  required: ["before", "after", "delta", "passed", "method"],
};

const GITHUB_ISSUE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string", description: "Markdown body with file refs, line numbers, evidence" },
    labels: { type: "array", items: { type: "string" } },
    finding_ids: { type: "array", items: { type: "string" } },
  },
  required: ["title", "body", "labels", "finding_ids"],
};

const GITHUB_ISSUES_SCHEMA = {
  type: "object",
  properties: {
    issues: { type: "array", items: GITHUB_ISSUE_SCHEMA },
  },
  required: ["issues"],
};

const FINAL_REPORT_SCHEMA = {
  type: "object",
  properties: {
    repo_path: { type: "string" },
    lines_deleted: { type: "number" },
    files_modified: { type: "number" },
    findings_auto_deleted: { type: "number" },
    findings_manual_review: { type: "number" },
    findings_kept: { type: "number" },
    complexity_delta: COMPLEXITY_DELTA_SCHEMA,
    github_issues_created: { type: "number" },
    outcome: { type: "string", enum: ["pass", "fail"], description: "fail if complexity went UP" },
    summary: { type: "string" },
  },
  required: [
    "repo_path", "lines_deleted", "files_modified",
    "findings_auto_deleted", "findings_manual_review", "findings_kept",
    "complexity_delta", "github_issues_created", "outcome", "summary",
  ],
};

// ─── Workflow ────────────────────────────────────────────────────────────────

const adversarialDebtWorkflow = pipeline("adversarial-debt", [

  // ── Phase 1: Discover repo + baseline ────────────────────────────────────
  phase("discovery", async (ctx) => {
    log("Phase 1: Discovery — scanning repo for dead code and duplicated logic");

    const repoPath = ctx.repo_path || "/home/ubuntu";

    const scanResults = await agent("scanner", {
      schema: { output: SCAN_RESULTS_SCHEMA },
      system: `You are a precise static analysis agent. You find ONLY:
1. Dead code: functions, classes, variables, exports, imports with zero confirmed callers/references.
   - Use grep, ripgrep, or AST traversal to count callers. Do NOT guess.
   - Exclude test files calling production symbols (those count as callers).
   - Dynamic requires, eval, reflection patterns → flag caller_count=-1 (dynamic, skip).
2. Duplicated logic: functions or blocks with >=80% similarity that do the same thing.
   - Near-duplicates count if core logic is identical but variable names differ.
   - Stdlib wrappers that exist in both files count.

DO NOT report:
- Style issues
- "This could be refactored" opinion
- Anything without file + line evidence
- Test helpers used only in tests (they have callers)

For baseline_complexity: count total if/else/for/while/switch/catch/&&/|| tokens across all non-test source files. Report the count and method="token_count".`,
      prompt: `Scan the repository at: ${repoPath}

Steps:
1. List all source files (exclude node_modules, .git, dist, build, coverage).
2. For each candidate dead symbol: grep -rn the symbol name across all source files, count non-self references. caller_count=0 means dead.
3. For duplicated logic: compare function bodies across files, compute similarity.
4. Count baseline complexity tokens.

Report ONLY confirmed findings with evidence.`,
      workdir: repoPath,
    });

    log(`Scan complete. Dead code: ${scanResults.dead_code.length}, Duplicated logic: ${scanResults.duplicated_logic.length}`);
    log(`Baseline complexity: ${scanResults.baseline_complexity.cyclomatic_total}`);

    return { ...ctx, scanResults, repoPath };
  }),

  // ── Phase 2: Adversarial verification (parallel per finding) ─────────────
  phase("adversarial-verify", async (ctx) => {
    log("Phase 2: Adversarial verification — Agent A defends, Agent B attacks");

    const allFindings = [
      ...ctx.scanResults.dead_code,
      ...ctx.scanResults.duplicated_logic,
    ];

    if (allFindings.length === 0) {
      log("No findings to verify.");
      return { ...ctx, verdicts: [] };
    }

    // Run adversarial pairs in parallel — one pair per finding
    const verdictBatches = await parallel(
      allFindings.map((finding) => async () => {
        const findingJson = JSON.stringify(finding, null, 2);

        // Agent A: Defender — argues for keeping
        const defenderTask = agent("defender", {
          schema: {
            output: {
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["keep", "unsure", "delete_ok"] },
                reasoning: { type: "string" },
              },
              required: ["verdict", "reasoning"],
            },
          },
          system: `You are a conservative code archaeologist. Your job: find reasons to KEEP code.
Look for:
- Load-bearing hacks (e.g., works around a browser bug, OS quirk, dependency limitation)
- Hidden callers: dynamic requires, __dirname tricks, plugin systems, eval, monkey-patching
- Feature flags that may activate this path
- Dead by grep but alive at runtime (serialization, ORM hooks, decorators)
- Removal cost > benefit (e.g., changes public API surface)
- The code is about to be used (recent git blame, open PR references)

Be SKEPTICAL of the scanner. Grep misses dynamic patterns.
verdict=keep: you found a real reason to keep it.
verdict=unsure: you suspect hidden use but can't confirm.
verdict=delete_ok: you genuinely can't find any reason to keep it.`,
          prompt: `Evaluate this finding. Argue for KEEPING it if you can find ANY reason:

${findingJson}

Check git blame, comments, recent commits, and dynamic usage patterns. Give your verdict and reasoning.`,
          workdir: ctx.repoPath,
        });

        // Agent B: Attacker — argues for deletion
        const attackerTask = agent("attacker", {
          schema: {
            output: {
              type: "object",
              properties: {
                verdict: { type: "string", enum: ["delete", "unsure", "keep"] },
                reasoning: { type: "string" },
              },
              required: ["verdict", "reasoning"],
            },
          },
          system: `You are a ruthless deletion advocate. Your job: prove this code should be DELETED.
Your arguments:
- Zero confirmed callers = dead, full stop
- "Might be used" is not evidence; evidence is evidence
- Duplicated logic increases maintenance surface and bug-fix divergence
- Dead code rots: it misleads future devs, slows searches, inflates bundle size
- The cost of keeping dead code compounds over time

Be AGGRESSIVE about deletion. Weak "keep" arguments (e.g., "someone might use this") don't count.
verdict=delete: clear, delete it.
verdict=unsure: deletion has real risk you can't resolve.
verdict=keep: you actually found a strong reason to keep it (rare).`,
          prompt: `Evaluate this finding. Argue for DELETING it:

${findingJson}

Confirm zero callers by alternative methods if possible. Give your verdict and reasoning.`,
          workdir: ctx.repoPath,
        });

        const [defenderResult, attackerResult] = await Promise.all([defenderTask, attackerTask]);

        // Compute consensus
        let consensus;
        if (defenderResult.verdict === "delete_ok" && attackerResult.verdict === "delete") {
          consensus = "auto_delete";
        } else if (defenderResult.verdict === "keep" && attackerResult.verdict === "keep") {
          consensus = "keep";
        } else {
          consensus = "manual_review";
        }

        // Risk: auto_delete only if both agree AND caller_count is explicitly 0
        const callerCount = finding.caller_count ?? finding.total_lines;
        const riskLevel =
          consensus === "auto_delete" && callerCount === 0 ? "low"
          : consensus === "manual_review" ? "medium"
          : "high";

        return {
          finding_id: finding.id,
          defender_verdict: defenderResult.verdict,
          defender_reasoning: defenderResult.reasoning,
          attacker_verdict: attackerResult.verdict,
          attacker_reasoning: attackerResult.reasoning,
          consensus,
          risk_level: riskLevel,
        };
      })
    );

    const verdicts = verdictBatches.flat();
    const autoDelete = verdicts.filter((v) => v.consensus === "auto_delete").length;
    const manualReview = verdicts.filter((v) => v.consensus === "manual_review").length;
    const keep = verdicts.filter((v) => v.consensus === "keep").length;

    log(`Verdicts: auto_delete=${autoDelete}, manual_review=${manualReview}, keep=${keep}`);

    return { ...ctx, verdicts };
  }),

  // ── Phase 3: Auto-apply deletions (only consensus=auto_delete) ───────────
  phase("auto-delete", async (ctx) => {
    log("Phase 3: Auto-applying safe deletions");

    const allFindings = [
      ...ctx.scanResults.dead_code,
      ...ctx.scanResults.duplicated_logic,
    ];

    const autoDeleteVerdicts = ctx.verdicts.filter((v) => v.consensus === "auto_delete");

    if (autoDeleteVerdicts.length === 0) {
      log("No auto-deletions to apply.");
      return { ...ctx, deletionResults: [] };
    }

    const deletionResults = await parallel(
      autoDeleteVerdicts.map((verdict) => async () => {
        const finding = allFindings.find((f) => f.id === verdict.finding_id);
        if (!finding) {
          return {
            finding_id: verdict.finding_id,
            applied: false,
            lines_deleted: 0,
            files_modified: [],
            error: "Finding not found in scan results",
          };
        }

        return await agent("deleter", {
          schema: { output: DELETION_RESULT_SCHEMA },
          system: `You are a surgical code deletion agent.
Rules:
1. Delete ONLY the exact lines specified. No refactoring, no cleanup, no bonus changes.
2. Before deleting: grep once more to confirm zero callers. If you find ANY caller, abort and set applied=false.
3. For dead imports: remove the import line only.
4. For duplicated logic: remove all but ONE copy. Keep the copy in the most-used file.
5. After deletion: ensure file still parses (no syntax errors).
6. Do NOT delete test files or test helpers.
7. Do NOT delete type definitions used by external consumers (check package exports).`,
          prompt: `Delete this confirmed-dead finding:

${JSON.stringify(finding, null, 2)}

Adversarial verdict:
- Defender said: ${verdict.defender_verdict} — ${verdict.defender_reasoning}
- Attacker said: ${verdict.attacker_verdict} — ${verdict.attacker_reasoning}

Steps:
1. Final caller verification: grep -rn "${finding.symbol || finding.symbols?.[0]}" in ${ctx.repoPath} (exclude the file itself and test files)
2. If callers found → set applied=false, report error
3. If zero callers → delete the exact lines, update imports if needed
4. Report lines_deleted and files_modified`,
          workdir: ctx.repoPath,
        });
      })
    );

    const totalDeleted = deletionResults.reduce((sum, r) => sum + (r.lines_deleted || 0), 0);
    const filesModified = [...new Set(deletionResults.flatMap((r) => r.files_modified || []))];

    log(`Auto-deletions applied: ${deletionResults.filter((r) => r.applied).length}/${autoDeleteVerdicts.length}`);
    log(`Lines deleted: ${totalDeleted}, Files modified: ${filesModified.length}`);

    return { ...ctx, deletionResults, totalLinesDeleted: totalDeleted, filesModified };
  }),

  // ── Phase 4: Measure complexity delta ────────────────────────────────────
  phase("measure-complexity", async (ctx) => {
    log("Phase 4: Measuring complexity delta post-deletion");

    const complexityDelta = await agent("complexity-checker", {
      schema: { output: COMPLEXITY_DELTA_SCHEMA },
      system: `You are a complexity measurement agent. Count total cyclomatic complexity tokens
(if/else/for/while/switch/catch/&&/||) across all non-test source files using the SAME method as baseline.
Report before (from baseline), after (recount now), delta (after-before), passed (delta<=0).`,
      prompt: `Baseline complexity was: ${ctx.scanResults.baseline_complexity.cyclomatic_total}
Method: ${ctx.scanResults.baseline_complexity.method}

Recount complexity in: ${ctx.repoPath}
Exclude: node_modules, .git, dist, build, coverage, **/*.test.*, **/*.spec.*

Report: before=${ctx.scanResults.baseline_complexity.cyclomatic_total}, after=<recount>, delta=after-before, passed=(delta<=0)`,
      workdir: ctx.repoPath,
    });

    if (!complexityDelta.passed) {
      log(`WARNING: Complexity INCREASED by ${complexityDelta.delta}. Workflow will FAIL.`);
    } else {
      log(`Complexity delta: ${complexityDelta.delta} (PASS)`);
    }

    return { ...ctx, complexityDelta };
  }),

  // ── Phase 5: Generate GitHub issues for manual-review findings ───────────
  phase("generate-issues", async (ctx) => {
    log("Phase 5: Generating GitHub issues for manual-review findings");

    const allFindings = [
      ...ctx.scanResults.dead_code,
      ...ctx.scanResults.duplicated_logic,
    ];

    const manualReviewVerdicts = ctx.verdicts.filter((v) => v.consensus === "manual_review");

    if (manualReviewVerdicts.length === 0) {
      log("No manual-review findings — no GitHub issues needed.");
      return { ...ctx, githubIssues: { issues: [] } };
    }

    const githubIssues = await agent("issue-writer", {
      schema: { output: GITHUB_ISSUES_SCHEMA },
      system: `You write actionable GitHub issues for technical debt that requires manual review.
Each issue must be:
- Specific: exact file paths, line numbers, symbol names
- Actionable: tells the dev exactly what to do
- Evidenced: includes the adversarial debate summary (why keep vs. why delete)
- Labeled correctly: use labels from [dead-code, duplicate-logic, tech-debt, needs-investigation]
- NOT a report: it's a task card, not an essay

Format the body as markdown with sections:
## Finding
## Evidence
## Adversarial Debate
## Recommended Action
## Acceptance Criteria

Group findings into one issue if they are in the same file and same category.`,
      prompt: `Create GitHub issues for these manual-review findings.

Findings needing manual review:
${JSON.stringify(
  manualReviewVerdicts.map((v) => ({
    verdict: v,
    finding: allFindings.find((f) => f.id === v.finding_id),
  })),
  null,
  2
)}

Auto-deleted findings (for context, do NOT create issues for these):
${JSON.stringify(
  ctx.verdicts
    .filter((v) => v.consensus === "auto_delete")
    .map((v) => allFindings.find((f) => f.id === v.finding_id)?.id),
  null,
  2
)}

Write concise, actionable issues. Each issue = one task a dev can complete and close.`,
      workdir: ctx.repoPath,
    });

    log(`GitHub issues generated: ${githubIssues.issues.length}`);

    return { ...ctx, githubIssues };
  }),

  // ── Phase 6: Final report ─────────────────────────────────────────────────
  phase("final-report", async (ctx) => {
    log("Phase 6: Compiling final report");

    const autoDeleted = ctx.verdicts.filter((v) => v.consensus === "auto_delete").length;
    const manualReview = ctx.verdicts.filter((v) => v.consensus === "manual_review").length;
    const kept = ctx.verdicts.filter((v) => v.consensus === "keep").length;

    const outcome = ctx.complexityDelta.passed ? "pass" : "fail";

    const report = {
      repo_path: ctx.repoPath,
      lines_deleted: ctx.totalLinesDeleted || 0,
      files_modified: (ctx.filesModified || []).length,
      findings_auto_deleted: autoDeleted,
      findings_manual_review: manualReview,
      findings_kept: kept,
      complexity_delta: ctx.complexityDelta,
      github_issues_created: ctx.githubIssues.issues.length,
      outcome,
      summary: `Adversarial debt elimination ${outcome.toUpperCase()}.
Lines deleted: ${ctx.totalLinesDeleted || 0}
Complexity: ${ctx.complexityDelta.before} → ${ctx.complexityDelta.after} (delta ${ctx.complexityDelta.delta})
Auto-deleted: ${autoDeleted} findings
Manual review needed: ${manualReview} GitHub issues created
Kept (load-bearing): ${kept} findings`,
    };

    log("─".repeat(60));
    log(report.summary);
    log("─".repeat(60));

    if (!ctx.complexityDelta.passed) {
      log("FAIL: Complexity increased after deletions. Investigate auto-deleted findings.");
      process.exitCode = 1;
    }

    // Emit structured outputs
    return {
      ...ctx,
      finalReport: report,
      // Attach GitHub issues for downstream consumption (e.g., gh issue create)
      githubIssuesPayload: ctx.githubIssues.issues,
    };
  }),
]);

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const repoPath = process.argv[2] || process.env.REPO_PATH || "/home/ubuntu";

  log(`Starting adversarial-debt workflow on: ${repoPath}`);
  log("Scope: dead code + duplicated logic ONLY");
  log("Method: adversarial agents (defender vs. attacker) per finding");
  log("Auto-delete: only when BOTH agents agree AND caller_count=0 confirmed");
  log("");

  try {
    const result = await adversarialDebtWorkflow.run({ repo_path: repoPath });

    // Print structured final report as JSON for pipeline consumption
    console.log(JSON.stringify(result.finalReport, null, 2));

    // Print GitHub issues as separate JSON block for gh CLI piping
    if (result.githubIssuesPayload?.length > 0) {
      console.error("\n--- GitHub Issues Payload ---");
      console.error(JSON.stringify(result.githubIssuesPayload, null, 2));
    }

    return result;
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { adversarialDebtWorkflow };
