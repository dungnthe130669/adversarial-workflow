// adversarial-deps.js
// Claude Code workflow: adversarial dependency audit
// Primitives: agent(), pipeline(), parallel(), phase(), log()

const MAX_CLASSIFY_AGENTS = 20;
const MAX_RETRY = 1;

const SCAN_SCHEMA = {
  type: "object",
  required: ["pkgManager", "packageJson", "lockfileSummary", "deps"],
  properties: {
    pkgManager: { type: "string", enum: ["npm", "yarn", "pnpm", "bun"] },
    packageJson: { type: "object" },
    lockfileSummary: { type: "string" },
    deps: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "version", "isDev", "bundleSize"],
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          isDev: { type: "boolean" },
          bundleSize: { type: "number", description: "bytes, 0 if unknown" }
        }
      }
    },
    hasDynamicRequire: { type: "boolean" }
  }
};

const BATCH_SCHEMA = {
  type: "object",
  required: ["unused", "trivial", "meaningful", "investigate"],
  properties: {
    unused: {
      type: "array",
      items: { type: "string" },
      description: "dep names never imported or referenced in source"
    },
    trivial: {
      type: "array",
      items: { type: "string" },
      description: "tiny utils where removal is clear-cut safe (e.g. is-odd)"
    },
    meaningful: {
      type: "array",
      items: { type: "string" },
      description: "deps clearly needed and not easily replaced"
    },
    investigate: {
      type: "array",
      items: { type: "string" },
      description: "deps that need deeper per-dep analysis"
    }
  }
};

const CLASSIFY_SCHEMA = {
  type: "object",
  required: ["name", "meaningfullyUsed", "replaceableWithStdlib", "reason", "stdlibAlternative"],
  properties: {
    name: { type: "string" },
    meaningfullyUsed: { type: "boolean" },
    replaceableWithStdlib: { type: "boolean" },
    reason: { type: "string" },
    stdlibAlternative: {
      type: "string",
      description: "which Node.js built-in(s) can replace it, or empty string"
    },
    usageSites: {
      type: "array",
      items: { type: "string" },
      description: "file:line references where dep is used"
    }
  }
};

const REPLACEMENT_SCHEMA = {
  type: "object",
  required: ["depName", "replacementCode", "affectedFiles", "testSnippet"],
  properties: {
    depName: { type: "string" },
    replacementCode: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "patch"],
        properties: {
          file: { type: "string" },
          patch: { type: "string", description: "unified diff or full replacement snippet" }
        }
      }
    },
    affectedFiles: { type: "array", items: { type: "string" } },
    testSnippet: { type: "string", description: "Jest/Node test asserting parity" }
  }
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "issues"],
  properties: {
    verdict: { type: "string", enum: ["approve", "reject", "patch-and-retry"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "description"],
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          description: { type: "string" }
        }
      }
    },
    patchSuggestion: {
      type: "string",
      description: "if patch-and-retry: specific fix the writer must apply"
    }
  }
};

const TRANSITIVE_SCHEMA = {
  type: "object",
  required: ["name", "safeToDrop", "transitiveUsers", "dynamicRequireRisk"],
  properties: {
    name: { type: "string" },
    safeToDrop: { type: "boolean" },
    transitiveUsers: { type: "array", items: { type: "string" } },
    dynamicRequireRisk: { type: "boolean" }
  }
};

const APPLY_SCHEMA = {
  type: "object",
  required: ["removed", "prSuggestions", "testPassed", "reverted"],
  properties: {
    removed: { type: "array", items: { type: "string" } },
    prSuggestions: {
      type: "array",
      items: {
        type: "object",
        required: ["depName", "description", "patchFiles"],
        properties: {
          depName: { type: "string" },
          description: { type: "string" },
          patchFiles: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "patch"],
              properties: {
                file: { type: "string" },
                patch: { type: "string" }
              }
            }
          }
        }
      }
    },
    testPassed: { type: "boolean" },
    reverted: { type: "boolean" }
  }
};

export default pipeline([

  // ─── Phase 0: Scan ────────────────────────────────────────────────────────
  phase("scan", async (ctx) => {
    log("Phase 0 — Scan: detecting package manager and reading deps");

    const scanResult = await agent(`
You are a Node.js dependency auditor. Perform a full project scan.

WORKSPACE: /home/ubuntu

Steps:
1. Detect package manager by checking for: bun.lockb → bun, pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm. Default npm.
2. Read package.json (dependencies + devDependencies).
3. Read the lockfile (first 200 lines for summary).
4. List ALL deps (name, version, isDev, estimated bundleSize in bytes — use 0 if unknown).
5. Scan all .js/.ts/.mjs/.cjs files for dynamic require patterns: require( followed by a non-literal (variable, template literal, expression). Set hasDynamicRequire=true if found.

Return structured data about the full dependency graph.
`, { schema: SCAN_SCHEMA });

    ctx.scan = scanResult;
    log(`Detected ${scanResult.deps.length} total deps via ${scanResult.pkgManager}`);
    if (scanResult.hasDynamicRequire) {
      log("WARNING: dynamic require() detected — auto-removal will be blocked for affected packages");
    }
    return ctx;
  }),

  // ─── Phase 1: Batch Triage ────────────────────────────────────────────────
  phase("batch-triage", async (ctx) => {
    log("Phase 1 — Batch Triage: single agent classifies ALL deps");

    const depList = ctx.scan.deps.map(d =>
      `${d.name}@${d.version} (${d.isDev ? "dev" : "prod"}, ~${d.bundleSize}b)`
    ).join("\n");

    const batchResult = await agent(`
You are a senior Node.js engineer performing a dependency audit triage.

PROJECT package.json:
${JSON.stringify(ctx.scan.packageJson, null, 2)}

ALL DEPENDENCIES (${ctx.scan.deps.length} total):
${depList}

WORKSPACE: /home/ubuntu

Your job: classify every single dependency into exactly one bucket.

BUCKETS:
- unused: never imported or referenced anywhere in source (grep the codebase)
- trivial: tiny single-purpose utils that are clearly unnecessary (e.g. is-odd, left-pad equivalents, lodash.get when optional chaining exists)
- meaningful: clearly essential deps — frameworks, databases, major libraries, anything complex to replace
- investigate: everything else — medium-sized utils that MIGHT be replaceable with Node.js stdlib but need deeper analysis

Rules:
- Scan src/**/* , lib/**/* , *.js , *.ts for actual import/require usage before marking unused
- When in doubt between trivial and investigate, use investigate
- When in doubt between meaningful and investigate, use investigate
- Be aggressive about meaningful for: React/Vue/Angular, Express/Fastify, database drivers, auth libs, bundlers, test frameworks
`, { schema: BATCH_SCHEMA });

    ctx.batch = batchResult;
    log(`Triage complete — unused:${batchResult.unused.length} trivial:${batchResult.trivial.length} meaningful:${batchResult.meaningful.length} investigate:${batchResult.investigate.length}`);
    return ctx;
  }),

  // ─── Phase 2: Parallel Classify (investigate bucket only) ─────────────────
  phase("classify", async (ctx) => {
    log("Phase 2 — Classify: per-dep deep analysis for investigate bucket");

    let investigateDeps = ctx.batch.investigate;

    // Cap at MAX_CLASSIFY_AGENTS — prioritize by bundle size descending
    if (investigateDeps.length > MAX_CLASSIFY_AGENTS) {
      log(`${investigateDeps.length} investigate deps → capping to ${MAX_CLASSIFY_AGENTS} by bundle size`);
      const sizeMap = Object.fromEntries(ctx.scan.deps.map(d => [d.name, d.bundleSize]));
      investigateDeps = investigateDeps
        .slice()
        .sort((a, b) => (sizeMap[b] || 0) - (sizeMap[a] || 0))
        .slice(0, MAX_CLASSIFY_AGENTS);
    }

    if (investigateDeps.length === 0) {
      log("No deps in investigate bucket — skipping classify phase");
      ctx.classified = [];
      return ctx;
    }

    log(`Classifying ${investigateDeps.length} deps in parallel`);

    const classifyTasks = investigateDeps.map(depName => {
      const depMeta = ctx.scan.deps.find(d => d.name === depName) || { name: depName, version: "unknown", isDev: false };
      return agent(`
You are a Node.js stdlib expert performing deep dependency analysis.

DEPENDENCY: ${depName}@${depMeta.version} (${depMeta.isDev ? "devDependency" : "dependency"})
WORKSPACE: /home/ubuntu

Tasks:
1. Search the codebase for every usage of this package (import, require, dynamic access).
   - List each usage site as "file:line: snippet"
   - If zero usages found → meaningfullyUsed=false
2. Assess if it's meaningfully used: does it provide non-trivial logic?
3. Assess replaceability with Node.js stdlib (v18+):
   - path, fs, crypto, util, stream, url, http, https, os, events, buffer, child_process, timers, assert, querystring, net, tls
   - Only mark replaceable if the FULL API surface used in this project is coverable
   - Check for: encoding edge cases, locale-sensitivity, DST/timezone handling, surrogate pair handling, argument overloads
   - Do NOT mark replaceable if the dep handles edge cases that stdlib doesn't

Return your analysis.
`, { schema: CLASSIFY_SCHEMA });
    });

    ctx.classified = await parallel(classifyTasks);
    log(`Classification done — ${ctx.classified.filter(c => c.replaceableWithStdlib).length} replaceable with stdlib`);
    return ctx;
  }),

  // ─── Phase 3: Adversarial Replacement ─────────────────────────────────────
  phase("adversarial", async (ctx) => {
    log("Phase 3 — Adversarial: writer + 2 reviewers for each replaceable dep");

    const replaceable = ctx.classified.filter(c => c.replaceableWithStdlib && c.meaningfullyUsed);
    if (replaceable.length === 0) {
      log("No replaceable deps found — skipping adversarial phase");
      ctx.approved = [];
      ctx.rejected = [];
      return ctx;
    }

    log(`Running adversarial review for ${replaceable.length} replaceable dep(s)`);

    const adversarialResults = [];

    for (const dep of replaceable) {
      log(`Adversarial: ${dep.name} → ${dep.stdlibAlternative}`);

      let replacement = null;
      let retries = 0;
      let finalVerdict = null;
      let patchHint = "";

      while (retries <= MAX_RETRY) {
        // Writer agent
        replacement = await agent(`
You are an expert Node.js refactoring engineer.

DEPENDENCY TO REPLACE: ${dep.name}
STDLIB ALTERNATIVE: ${dep.stdlibAlternative}
USAGE SITES:
${(dep.usageSites || []).join("\n")}
REASON FOR REPLACEMENT: ${dep.reason}
WORKSPACE: /home/ubuntu
${patchHint ? `\nPREVIOUS REVIEW PATCH SUGGESTION (apply this fix):\n${patchHint}` : ""}

Write complete replacement code using ONLY Node.js built-ins.
Requirements:
- Produce a unified diff or full replacement for each affected file
- Cover ALL usage sites found above
- Handle all edge cases the original library handled (check its source/docs)
- Write a test snippet asserting behavioral parity
- Do NOT leave any import/require of ${dep.name} in the codebase
`, { schema: REPLACEMENT_SCHEMA });

        // Reviewer A: correctness + edge cases
        const reviewA = await agent(`
You are Reviewer A — a correctness adversary.

REPLACEMENT PROPOSAL for ${dep.name} → ${dep.stdlibAlternative}:
${JSON.stringify(replacement, null, 2)}

ORIGINAL USAGE SITES:
${(dep.usageSites || []).join("\n")}

Attack this replacement ruthlessly for:
1. Correctness bugs — wrong logic, off-by-one, incorrect API usage
2. Edge cases the original library handled:
   - Encoding issues (UTF-8, UTF-16, BOM, surrogate pairs)
   - Locale-sensitive operations (sort, toUpperCase, date formatting)
   - DST / timezone edge cases
   - Empty input, null, undefined, NaN handling
   - Large input behavior
3. Missing error handling
4. Race conditions or async issues

Verdict: approve (no critical issues) | reject (critical unfixable issues) | patch-and-retry (fixable with specific changes)
`, { schema: REVIEW_SCHEMA });

        // Reviewer B: API surface compatibility
        const reviewB = await agent(`
You are Reviewer B — an API compatibility adversary.

REPLACEMENT PROPOSAL for ${dep.name} → ${dep.stdlibAlternative}:
${JSON.stringify(replacement, null, 2)}

ORIGINAL USAGE SITES:
${(dep.usageSites || []).join("\n")}

Attack this replacement ruthlessly for:
1. API surface mismatches:
   - Argument count / order differences
   - Return type differences (sync vs async, object shape)
   - Overloaded signatures the stdlib doesn't support
   - Side effects the original had (events emitted, globals mutated)
2. Version compatibility — does the stdlib version used exist in the project's Node.js target?
3. Missing re-exports or named exports that callers depend on
4. TypeScript type compatibility (if project uses TS)

Verdict: approve (no critical issues) | reject (critical unfixable issues) | patch-and-retry (fixable with specific changes)
`, { schema: REVIEW_SCHEMA });

        const aVerdict = reviewA.verdict;
        const bVerdict = reviewB.verdict;

        log(`${dep.name} review — A:${aVerdict} B:${bVerdict} (attempt ${retries + 1})`);

        if (aVerdict === "approve" && bVerdict === "approve") {
          finalVerdict = "approve";
          break;
        } else if (aVerdict === "reject" || bVerdict === "reject") {
          finalVerdict = "reject";
          break;
        } else if (retries < MAX_RETRY) {
          // At least one patch-and-retry, no reject — retry once
          patchHint = [
            reviewA.patchSuggestion ? `Reviewer A: ${reviewA.patchSuggestion}` : "",
            reviewB.patchSuggestion ? `Reviewer B: ${reviewB.patchSuggestion}` : ""
          ].filter(Boolean).join("\n");
          retries++;
          log(`${dep.name} — patch-and-retry (attempt ${retries + 1})`);
        } else {
          // Exhausted retries, still patch-and-retry verdict → reject
          finalVerdict = "reject";
          break;
        }
      }

      adversarialResults.push({
        dep,
        replacement,
        verdict: finalVerdict
      });
    }

    ctx.approved = adversarialResults.filter(r => r.verdict === "approve");
    ctx.rejected = adversarialResults.filter(r => r.verdict === "reject");
    log(`Adversarial complete — approved:${ctx.approved.length} rejected:${ctx.rejected.length}`);
    return ctx;
  }),

  // ─── Phase 4: Apply ────────────────────────────────────────────────────────
  phase("apply", async (ctx) => {
    log("Phase 4 — Apply: sequential safe removals + PR suggestions");

    // Combine: unused from batch triage + unused from classify (not meaningfully used)
    const unusedFromBatch = ctx.batch.unused;
    const unusedFromClassify = (ctx.classified || [])
      .filter(c => !c.meaningfullyUsed)
      .map(c => c.name);
    const trivialDeps = ctx.batch.trivial;

    const candidatesForRemoval = [...new Set([
      ...unusedFromBatch,
      ...unusedFromClassify,
      ...trivialDeps
    ])];

    // Only remove devDependencies — never auto-remove prod deps
    const devDepNames = new Set(
      ctx.scan.deps.filter(d => d.isDev).map(d => d.name)
    );
    const devCandidates = candidatesForRemoval.filter(name => devDepNames.has(name));

    log(`Removal candidates (devDeps only): ${devCandidates.join(", ") || "none"}`);

    // Sequential transitive checks + apply
    const confirmed = [];
    const skipped = [];

    for (const depName of devCandidates) {
      const transitiveCheck = await agent(`
You are a Node.js dependency safety checker.

DEPENDENCY TO CHECK: ${depName}
PACKAGE MANAGER: ${ctx.scan.pkgManager}
WORKSPACE: /home/ubuntu
DYNAMIC REQUIRE RISK: ${ctx.scan.hasDynamicRequire ? "YES — project uses dynamic require()" : "NO"}

Safety checks before removal:
1. Run: ${ctx.scan.pkgManager === "yarn" ? `yarn why ${depName}` : ctx.scan.pkgManager === "pnpm" ? `pnpm why ${depName}` : `npm ls ${depName}`}
   List ALL packages that depend on ${depName} transitively.
2. Check if any OTHER dep in package.json (dep or devDep) lists ${depName} as a dependency.
3. If hasDynamicRequire is YES, scan for any dynamic require pattern that could be loading ${depName} at runtime.
4. Safe to drop only if: zero transitive users, zero other deps rely on it, no dynamic require risk.

Report your findings.
`, { schema: TRANSITIVE_SCHEMA });

      if (transitiveCheck.safeToDrop) {
        confirmed.push(depName);
        log(`✓ ${depName} — safe to remove`);
      } else {
        skipped.push(depName);
        log(`✗ ${depName} — skipped (transitive users: ${transitiveCheck.transitiveUsers.join(", ") || "dynamic require risk"})`);
      }
    }

    // Build PR suggestions for approved stdlib replacements
    const prSuggestions = ctx.approved.map(r => ({
      depName: r.dep.name,
      description: `Replace ${r.dep.name} with ${r.dep.stdlibAlternative} (Node.js built-in). Passes adversarial review.`,
      patchFiles: r.replacement.replacementCode
    }));

    // Perform the actual removal + test
    const applyResult = await agent(`
You are a Node.js package maintainer performing safe dependency removal.

WORKSPACE: /home/ubuntu
PACKAGE MANAGER: ${ctx.scan.pkgManager}
CONFIRMED SAFE TO REMOVE (devDeps only): ${confirmed.join(" ") || "none"}
SKIPPED (transitive risk): ${skipped.join(" ") || "none"}

Steps (SEQUENTIAL — do not parallelize package.json edits):
1. For each confirmed dep, run the appropriate remove command:
   - npm: npm uninstall --save-dev <dep>
   - yarn: yarn remove <dep>
   - pnpm: pnpm remove <dep>
   - bun: bun remove <dep>
2. After ALL removals are done, run the project test suite: ${ctx.scan.pkgManager === "yarn" ? "yarn test" : ctx.scan.pkgManager === "pnpm" ? "pnpm test" : ctx.scan.pkgManager === "bun" ? "bun test" : "npm test"}
3. If tests PASS: report testPassed=true, reverted=false
4. If tests FAIL: run \`git checkout package.json ${ctx.scan.pkgManager === "npm" ? "package-lock.json" : ctx.scan.pkgManager === "yarn" ? "yarn.lock" : ctx.scan.pkgManager === "pnpm" ? "pnpm-lock.yaml" : "bun.lockb"}\` to revert ALL changes, then reinstall (${ctx.scan.pkgManager} install), report testPassed=false, reverted=true

PR suggestions to emit (do NOT apply these — output only):
${JSON.stringify(prSuggestions, null, 2)}
`, { schema: APPLY_SCHEMA });

    log(`Apply complete — removed:${applyResult.removed.length} testPassed:${applyResult.testPassed} reverted:${applyResult.reverted}`);
    log(`PR suggestions ready: ${applyResult.prSuggestions.length}`);

    if (applyResult.reverted) {
      log("WARNING: Test suite failed after removal — ALL changes reverted");
    }

    // Final summary
    log("═══════════════════════════════════════════════");
    log("ADVERSARIAL DEPS AUDIT COMPLETE");
    log("═══════════════════════════════════════════════");
    log(`Package manager: ${ctx.scan.pkgManager}`);
    log(`Total deps scanned: ${ctx.scan.deps.length}`);
    log(`Batch triage — unused:${ctx.batch.unused.length} trivial:${ctx.batch.trivial.length} meaningful:${ctx.batch.meaningful.length} investigate:${ctx.batch.investigate.length}`);
    log(`Classify — replaceable:${(ctx.classified || []).filter(c => c.replaceableWithStdlib).length}`);
    log(`Adversarial — approved:${(ctx.approved || []).length} rejected:${(ctx.rejected || []).length}`);
    log(`Applied removals: ${applyResult.removed.join(", ") || "none"}`);
    log(`PR suggestions: ${applyResult.prSuggestions.length}`);
    if (applyResult.prSuggestions.length > 0) {
      applyResult.prSuggestions.forEach(pr => {
        log(`  → ${pr.depName}: ${pr.description}`);
      });
    }

    return {
      ...ctx,
      apply: applyResult
    };
  })

]);
