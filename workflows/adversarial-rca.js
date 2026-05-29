/**
 * adversarial-rca.js
 * Claude Code Workflow: Adversarial Root Cause Analysis for Incident Post-Mortems
 *
 * Input:  INCIDENT.md  (timeline, symptoms, what was done)
 * Output: RCA_REPORT.md + code change suggestions + runbook updates
 *
 * Primitives: agent(), pipeline(), parallel(), phase(), log()
 */

const FIVE_WHY_SCHEMA = {
  type: "object",
  required: ["angle", "initial_symptom", "why_chain", "stated_root_cause", "confidence"],
  properties: {
    angle: { type: "string", enum: ["infrastructure", "code", "process_human"] },
    initial_symptom: { type: "string" },
    why_chain: {
      type: "array",
      minItems: 3,
      maxItems: 7,
      items: {
        type: "object",
        required: ["level", "question", "answer", "evidence"],
        properties: {
          level: { type: "integer", minimum: 1, maximum: 7 },
          question: { type: "string" },
          answer: { type: "string" },
          evidence: { type: "string", description: "Specific log line, metric value, or artifact supporting this answer" }
        }
      }
    },
    stated_root_cause: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
};

const ADVERSARIAL_REVIEW_SCHEMA = {
  type: "object",
  required: ["target_angle", "verdict", "challenges", "surviving_root_cause", "rejected_as_symptom"],
  properties: {
    target_angle: { type: "string" },
    verdict: { type: "string", enum: ["confirmed_root_cause", "symptom_not_root_cause", "partial_root_cause", "insufficient_evidence"] },
    challenges: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["challenge", "counterevidence", "severity"],
        properties: {
          challenge: { type: "string", description: "Specific challenge to the claimed root cause" },
          counterevidence: { type: "string", description: "Evidence that contradicts or undermines the root cause claim" },
          severity: { type: "string", enum: ["fatal", "major", "minor"] }
        }
      }
    },
    surviving_root_cause: {
      type: "string",
      description: "If verdict is confirmed or partial, the refined root cause statement after challenges"
    },
    rejected_as_symptom: {
      type: "boolean",
      description: "True if the claimed root cause is actually a downstream symptom"
    },
    demand_for_specificity: {
      type: "string",
      description: "If root cause is too vague (e.g. 'need more tests'), state what SPECIFIC thing is demanded"
    }
  }
};

const REMEDIATION_SCHEMA = {
  type: "object",
  required: ["root_cause", "remediations"],
  properties: {
    root_cause: { type: "string" },
    remediations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["type", "description", "specificity_check", "implementation"],
        properties: {
          type: { type: "string", enum: ["code_change", "config_change", "runbook_update", "alert_rule", "architectural_change"] },
          description: { type: "string" },
          specificity_check: {
            type: "object",
            required: ["passes", "rejection_reason"],
            properties: {
              passes: { type: "boolean" },
              rejection_reason: {
                type: "string",
                description: "Why this remediation was rejected as too vague. Empty string if passes=true"
              }
            }
          },
          implementation: {
            type: "object",
            required: ["file_path", "change_description", "code_snippet"],
            properties: {
              file_path: { type: "string", description: "Exact file path for the change, or 'runbook/RUNBOOK.md'" },
              change_description: { type: "string" },
              code_snippet: { type: "string", description: "Actual code, config, or runbook text to add/modify" },
              alert_threshold: {
                type: "string",
                description: "For alert_rule type: specific metric name + numeric threshold + window + severity"
              }
            }
          },
          priority: { type: "string", enum: ["immediate", "short_term", "long_term"] },
          estimated_effort: { type: "string", enum: ["hours", "days", "weeks"] }
        }
      }
    }
  }
};

const RCA_SYNTHESIS_SCHEMA = {
  type: "object",
  required: ["incident_summary", "confirmed_root_causes", "rejected_claims", "timeline_gaps", "systemic_findings"],
  properties: {
    incident_summary: { type: "string" },
    confirmed_root_causes: {
      type: "array",
      items: {
        type: "object",
        required: ["root_cause", "angle", "confidence"],
        properties: {
          root_cause: { type: "string" },
          angle: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    rejected_claims: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "rejection_reason", "what_it_actually_is"],
        properties: {
          claim: { type: "string" },
          rejection_reason: { type: "string" },
          what_it_actually_is: { type: "string", description: "Symptom, contributing factor, or trigger — not root cause" }
        }
      }
    },
    timeline_gaps: { type: "array", items: { type: "string" } },
    systemic_findings: { type: "array", items: { type: "string" } }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1: Read and parse the incident document
// ─────────────────────────────────────────────────────────────────────────────

const parseIncident = phase("parse_incident", async (ctx) => {
  log("📋 Parsing INCIDENT.md...");

  const incidentContent = await agent(
    `Read the file INCIDENT.md from the current working directory and extract:
1. Incident title and severity
2. Complete timeline of events (with timestamps if available)
3. Symptoms observed
4. Systems affected
5. Actions taken during the incident
6. Current status (resolved/ongoing)
7. Any hypotheses already proposed

Return a structured summary preserving ALL timeline details and technical specifics.
Do NOT summarize away numbers, error codes, metric values — keep them verbatim.`,
    {
      schema: {
        type: "object",
        required: ["title", "severity", "timeline", "symptoms", "systems_affected", "actions_taken", "status"],
        properties: {
          title: { type: "string" },
          severity: { type: "string" },
          timeline: { type: "array", items: { type: "string" } },
          symptoms: { type: "array", items: { type: "string" } },
          systems_affected: { type: "array", items: { type: "string" } },
          actions_taken: { type: "array", items: { type: "string" } },
          status: { type: "string" },
          existing_hypotheses: { type: "array", items: { type: "string" } },
          raw_details: { type: "string" }
        }
      }
    }
  );

  log(`✅ Parsed incident: ${incidentContent.title} (${incidentContent.severity})`);
  log(`   Timeline events: ${incidentContent.timeline.length}`);
  log(`   Systems affected: ${incidentContent.systems_affected.join(", ")}`);

  return incidentContent;
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2: Parallel 5-Why analysis from 3 angles
// ─────────────────────────────────────────────────────────────────────────────

const infraAnalysis = (incident) => agent(
  `You are an infrastructure/SRE expert performing a 5-Why root cause analysis.

INCIDENT DATA:
${JSON.stringify(incident, null, 2)}

Analyze this incident from the INFRASTRUCTURE angle:
- Hardware failures, capacity limits, network issues
- Kubernetes/container scheduling, resource limits, OOMKills
- Database performance, connection pools, storage I/O
- Load balancer, DNS, CDN, routing issues
- Cloud provider failures, AZ/region issues
- Certificate expiry, rate limits, quota exhaustion

Rules:
1. Each "why" must be answerable with evidence from the incident data
2. If you don't have evidence, state what log/metric WOULD prove it
3. Do NOT stop at a symptom — keep asking why until you reach a systemic cause
4. "The server ran out of memory" is a symptom. "Memory limit was set to X but service grew to Y under Z load pattern due to W" is approaching root cause
5. Your stated_root_cause must be falsifiable — it must be possible to prove it wrong

Perform a rigorous 5-Why chain.`,
  { schema: FIVE_WHY_SCHEMA }
);

const codeAnalysis = (incident) => agent(
  `You are a senior software engineer performing a 5-Why root cause analysis.

INCIDENT DATA:
${JSON.stringify(incident, null, 2)}

Analyze this incident from the CODE/SOFTWARE angle:
- Logic errors, race conditions, deadlocks
- Missing error handling, swallowed exceptions
- N+1 queries, missing indexes, full table scans
- Memory leaks, goroutine leaks, connection leaks
- Incorrect timeouts, retry storms, thundering herd
- Missing circuit breakers, backpressure, backoff
- Deployment/release issues, feature flags, config changes
- Dependency failures, library bugs, API contract violations

Rules:
1. Each "why" must be answerable with evidence from the incident data
2. Reference specific functions, classes, or code paths where possible
3. "There was a bug" is NOT acceptable — name the bug pattern
4. Deployment timing correlations are evidence, not root causes — dig deeper
5. Your stated_root_cause must be a specific, fixable code issue

Perform a rigorous 5-Why chain.`,
  { schema: FIVE_WHY_SCHEMA }
);

const processAnalysis = (incident) => agent(
  `You are an organizational/process expert performing a 5-Why root cause analysis.

INCIDENT DATA:
${JSON.stringify(incident, null, 2)}

Analyze this incident from the PROCESS/HUMAN angle:
- Missing or inadequate runbooks
- Insufficient monitoring/alerting (not "add more monitoring" — WHAT specific gap)
- Review process failures (what check didn't catch this)
- On-call handoff issues, knowledge silos
- Deployment process gaps (missing rollback plan, canary, feature flag)
- Post-incident action items from previous incidents not completed
- Organizational pressure leading to cutting corners
- Training gaps — specific knowledge that was missing

Rules:
1. "We need better monitoring" is REJECTED — specify: what metric, what threshold, what alert
2. "We need more tests" is REJECTED — specify: what test type, what scenario, what assertion
3. Process gaps must be specific enough to write a ticket from
4. Human error is a starting point, not a root cause — why was the human able to make that error?
5. Blame-free but specific: name the process failure, not the person

Perform a rigorous 5-Why chain.`,
  { schema: FIVE_WHY_SCHEMA }
);

const parallelAnalysis = phase("parallel_five_why_analysis", async (ctx) => {
  log("🔍 Running parallel 5-Why analysis from 3 angles...");

  const [infra, code, process] = await parallel([
    () => infraAnalysis(ctx.incident),
    () => codeAnalysis(ctx.incident),
    () => processAnalysis(ctx.incident)
  ]);

  log("✅ All 3 analysis angles complete");
  log(`   Infra root cause: ${infra.stated_root_cause.substring(0, 80)}...`);
  log(`   Code root cause: ${code.stated_root_cause.substring(0, 80)}...`);
  log(`   Process root cause: ${process.stated_root_cause.substring(0, 80)}...`);

  return { infra, code, process };
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3: Adversarial review — 2 reviewers challenge each root cause
// ─────────────────────────────────────────────────────────────────────────────

const adversarialReview = (targetAnalysis, reviewerNumber, incident) => agent(
  `You are Adversarial Reviewer #${reviewerNumber}. Your job is to CHALLENGE the following root cause analysis.

YOUR MANDATE:
- Is the "root cause" actually a symptom of something deeper?
- Is the evidence cited actually causal or just correlational?
- Could the same incident have occurred even if this root cause were fixed?
- Is the root cause statement specific enough to act on?
- Are there alternative explanations not considered?

REJECT as "symptom_not_root_cause" if:
- Fixing it would prevent THIS incident but not the next similar one
- It's a proximate cause, not the systemic failure
- It couldn't happen without an enabling condition that wasn't examined

REJECT as "insufficient_evidence" if:
- The evidence cited doesn't actually support the conclusion
- Key evidence is missing and the analysis assumes without proving

REJECT as "partial_root_cause" if:
- The analysis is on the right track but stopped too early
- Multiple contributing causes were conflated into one

DEMAND SPECIFICITY for any remediation vagueness:
- "improve monitoring" → demand: what metric, what threshold, what alert, what pagerduty policy
- "add tests" → demand: what test framework, what test case, what input, what assertion
- "improve process" → demand: what specific step added to which specific checklist

INCIDENT DATA:
${JSON.stringify(incident, null, 2)}

TARGET ANALYSIS TO CHALLENGE:
${JSON.stringify(targetAnalysis, null, 2)}

Be adversarial but fair. If the root cause genuinely holds up to scrutiny, confirm it.
A confirmed root cause must be: specific, causal (not correlational), actionable, and falsifiable.`,
  { schema: ADVERSARIAL_REVIEW_SCHEMA }
);

const adversarialReviewPhase = phase("adversarial_review", async (ctx) => {
  log("⚔️  Running adversarial reviews (2 reviewers × 3 analyses = 6 reviews)...");

  const { infra, code, process } = ctx.analyses;
  const incident = ctx.incident;

  const [
    infraReview1, infraReview2,
    codeReview1, codeReview2,
    processReview1, processReview2
  ] = await parallel([
    () => adversarialReview(infra, 1, incident),
    () => adversarialReview(infra, 2, incident),
    () => adversarialReview(code, 1, incident),
    () => adversarialReview(code, 2, incident),
    () => adversarialReview(process, 1, incident),
    () => adversarialReview(process, 2, incident)
  ]);

  const reviews = {
    infra: [infraReview1, infraReview2],
    code: [codeReview1, codeReview2],
    process: [processReview1, processReview2]
  };

  // Log verdicts
  for (const [angle, [r1, r2]] of Object.entries(reviews)) {
    log(`   ${angle}: Reviewer1=${r1.verdict}, Reviewer2=${r2.verdict}`);
  }

  return reviews;
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: Adjudicate — only confirmed root causes proceed to remediation
// ─────────────────────────────────────────────────────────────────────────────

const adjudicateRootCauses = phase("adjudicate", async (ctx) => {
  log("⚖️  Adjudicating root causes from adversarial reviews...");

  const { analyses, reviews, incident } = ctx;

  const adjudication = await agent(
    `You are the Chief Reliability Officer adjudicating a disputed root cause analysis.

You have:
1. Three 5-Why analyses (infra, code, process)
2. Two adversarial reviews for each analysis

Your job:
1. For each angle, synthesize the two reviews into a final verdict
2. A root cause CONFIRMS if:
   - Both reviewers confirm it, OR
   - One confirms and one says "partial" with the surviving_root_cause being specific enough
3. A root cause is REJECTED if:
   - Either reviewer marks it "symptom_not_root_cause" with a fatal challenge, OR
   - Both reviewers mark it "insufficient_evidence"
4. If a root cause is partial, use the refined surviving_root_cause from the review

CRITICAL: Rejected root causes must still be explained — state what they actually are
(symptom, contributing factor, trigger) so they appear in the report.

INCIDENT: ${JSON.stringify(incident, null, 2)}

ANALYSES: ${JSON.stringify(analyses, null, 2)}

REVIEWS: ${JSON.stringify(reviews, null, 2)}`,
    { schema: RCA_SYNTHESIS_SCHEMA }
  );

  log(`✅ Adjudication complete`);
  log(`   Confirmed root causes: ${adjudication.confirmed_root_causes.length}`);
  log(`   Rejected claims: ${adjudication.rejected_claims.length}`);

  if (adjudication.confirmed_root_causes.length === 0) {
    log("⚠️  WARNING: No root causes survived adversarial review. Report will note evidence gaps.");
  }

  return adjudication;
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5: Remediation — specific actions for confirmed root causes only
// ─────────────────────────────────────────────────────────────────────────────

const buildRemediation = (rootCause, incident) => agent(
  `You are a senior engineer writing SPECIFIC remediations for a confirmed root cause.

ROOT CAUSE: ${rootCause.root_cause}
ANGLE: ${rootCause.angle}
CONFIDENCE: ${rootCause.confidence}

INCIDENT CONTEXT: ${JSON.stringify(incident, null, 2)}

Write concrete remediations. Each must pass the SPECIFICITY CHECK:

❌ REJECTED (too vague):
- "Add monitoring" → REJECTED
- "Improve test coverage" → REJECTED
- "Better deployment process" → REJECTED
- "Add circuit breaker" → REJECTED (which service, which dependency, what threshold)

✅ ACCEPTED (specific):
- "Add prometheus metric http_downstream_timeout_total{service='payments',dependency='stripe'} and alert when p99 > 2s for 5 consecutive minutes, page on-call"
- "Add integration test in payments/tests/test_stripe_timeout.py: mock stripe returning 504 after 30s, assert circuit opens after 3 failures within 60s"
- "Add to deploy runbook step 7: verify payments service /health endpoint returns 200 with stripe_connectivity: true before cutting traffic"
- "In payments/client.go line ~340: add exponential backoff with jitter: base=100ms, max=30s, multiplier=2, jitter=0.1, max_attempts=5"

For each remediation:
- type: code_change / config_change / runbook_update / alert_rule / architectural_change
- implementation.file_path: exact file path (not "src/somewhere")
- implementation.code_snippet: actual code/config/runbook text, not pseudocode
- For alert_rule type: alert_threshold must be metric_name + numeric_threshold + window + severity

Reject your own vague ideas before I do.`,
  { schema: REMEDIATION_SCHEMA }
);

const remediationPhase = phase("remediation", async (ctx) => {
  log("🔧 Building specific remediations for confirmed root causes...");

  const { synthesis, incident } = ctx;
  const { confirmed_root_causes } = synthesis;

  if (confirmed_root_causes.length === 0) {
    log("⚠️  No confirmed root causes — generating evidence-gathering remediations");
    return [{
      root_cause: "UNDETERMINED — insufficient evidence",
      remediations: [{
        type: "runbook_update",
        description: "Add evidence collection steps to incident runbook",
        specificity_check: { passes: true, rejection_reason: "" },
        implementation: {
          file_path: "runbook/RUNBOOK.md",
          change_description: "Add evidence collection checklist for future incidents of this type",
          code_snippet: `## Evidence Collection Checklist (added post-incident ${new Date().toISOString().split("T")[0]})\n\n- [ ] Export metrics from ${incident.systems_affected ? incident.systems_affected.join(", ") : "affected systems"} for T-1h to T+2h window\n- [ ] Capture distributed traces for failed requests\n- [ ] Export structured logs with correlation IDs\n- [ ] Record deployment history 24h before incident\n- [ ] Note any config or feature flag changes`
        },
        priority: "immediate",
        estimated_effort: "hours"
      }]
    }];
  }

  const remediations = await parallel(
    confirmed_root_causes.map((rc) => () => buildRemediation(rc, incident))
  );

  // Filter out non-specific remediations
  for (const rem of remediations) {
    const before = rem.remediations.length;
    rem.remediations = rem.remediations.filter((r) => r.specificity_check.passes);
    const dropped = before - rem.remediations.length;
    if (dropped > 0) {
      log(`   ⚠️  Dropped ${dropped} vague remediation(s) from root cause: ${rem.root_cause.substring(0, 60)}`);
    }
  }

  log(`✅ Remediations built: ${remediations.reduce((sum, r) => sum + r.remediations.length, 0)} specific actions`);
  return remediations;
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6: Write output files
// ─────────────────────────────────────────────────────────────────────────────

const writeOutputs = phase("write_outputs", async (ctx) => {
  log("📝 Writing RCA_REPORT.md and supporting artifacts...");

  const { incident, synthesis, remediations, analyses, reviews } = ctx;

  await agent(
    `Write a complete RCA_REPORT.md file to disk using the write_file tool or bash.

The report must include these sections in order:

# Incident RCA: ${incident.title}
**Date:** ${new Date().toISOString().split("T")[0]}
**Severity:** ${incident.severity}
**Status:** ${incident.status}

## Executive Summary
One paragraph: what happened, impact, duration, how resolved.

## Timeline
Full timeline from incident data, formatted as markdown list with timestamps.

## Confirmed Root Causes
For each confirmed root cause:
### RC-N: [Root Cause Statement]
- **Angle:** infra/code/process
- **Confidence:** X%
- **5-Why Chain:** (embed the relevant chain)
- **Adversarial Review Verdict:** (how it survived review)

## Rejected Claims (Symptoms, Not Root Causes)
Table or list of what was initially suspected but rejected, why, and what they actually were.
Format as:
### ~~[Claim]~~
- **Rejected because:** [reason]
- **Actually is:** [symptom/trigger/contributing factor]

## Remediations
For each confirmed root cause, all specific remediations that passed specificity check:
### For RC-N
#### [Remediation type]: [Description]
- **File:** \`path/to/file\`
- **Priority:** immediate/short_term/long_term
- **Effort:** hours/days/weeks
- **Change:**
\`\`\`[language]
[code_snippet]
\`\`\`
[If alert_rule: **Alert threshold:** metric + threshold + window + severity]

## Systemic Findings
Patterns that suggest broader organizational or architectural issues.

## Timeline Gaps
Missing data that would have helped the RCA — recommended for future observability.

## Action Items
Numbered, prioritized list. Each must be a ticket-ready task with owner role.

## What We Learned
Brief, forward-looking lessons. No blame. Focus on system/process improvement.

---
*RCA generated by adversarial-rca.js workflow*
*Analyses: ${analyses ? Object.keys(analyses).join(", ") : "infra, code, process"}*

FULL DATA TO USE:
INCIDENT: ${JSON.stringify(incident, null, 2)}
SYNTHESIS: ${JSON.stringify(synthesis, null, 2)}
REMEDIATIONS: ${JSON.stringify(remediations, null, 2)}
ANALYSES: ${JSON.stringify(analyses, null, 2)}
REVIEWS: ${JSON.stringify(reviews, null, 2)}

Write this as RCA_REPORT.md in the current working directory.`,
    {}
  );

  // Write code change files if any code_change remediations exist
  const codeChanges = remediations
    .flatMap((r) => r.remediations)
    .filter((r) => r.type === "code_change" && r.implementation.file_path !== "runbook/RUNBOOK.md");

  if (codeChanges.length > 0) {
    log(`📄 Writing CODE_CHANGES.md with ${codeChanges.length} specific code change(s)...`);
    await agent(
      `Write a CODE_CHANGES.md file describing the exact code changes needed.

For each change:
## Change N: [description]
**File:** \`[file_path]\`
**Root Cause Addressed:** [root_cause]
**Priority:** [priority]

### Before (if modifying existing code)
\`\`\`
[what the code looks like now, or "NEW FILE"]
\`\`\`

### After
\`\`\`
[the code_snippet with changes]
\`\`\`

**Testing:** What test should be written or run to verify this fix.

CODE CHANGES DATA:
${JSON.stringify(codeChanges, null, 2)}

Write as CODE_CHANGES.md in current working directory.`,
      {}
    );
  }

  // Write runbook updates
  const runbookChanges = remediations
    .flatMap((r) => r.remediations)
    .filter((r) => r.type === "runbook_update" || r.implementation.file_path === "runbook/RUNBOOK.md");

  if (runbookChanges.length > 0) {
    log(`📄 Writing RUNBOOK_UPDATES.md with ${runbookChanges.length} runbook update(s)...`);
    await agent(
      `Write a RUNBOOK_UPDATES.md file with specific runbook additions.

For each runbook update:
## Update N: [description]
**Target Runbook:** [file_path]
**Applies to:** [what scenario this handles]
**Add this section:**
\`\`\`markdown
[code_snippet - the actual runbook text to add]
\`\`\`

RUNBOOK CHANGES DATA:
${JSON.stringify(runbookChanges, null, 2)}

Write as RUNBOOK_UPDATES.md in current working directory.`,
      {}
    );
  }

  // Write alert rules
  const alertRules = remediations
    .flatMap((r) => r.remediations)
    .filter((r) => r.type === "alert_rule");

  if (alertRules.length > 0) {
    log(`📄 Writing ALERT_RULES.md with ${alertRules.length} alert rule(s)...`);
    await agent(
      `Write an ALERT_RULES.md file with specific, copy-paste-ready alert configurations.

For each alert rule:
## Alert N: [description]
**Metric:** [metric_name]
**Threshold:** [numeric_threshold]
**Window:** [time_window]
**Severity:** [severity]
**Root Cause Addressed:** [what this would have caught]

### Prometheus/Alertmanager Rule
\`\`\`yaml
[yaml alert rule config]
\`\`\`

### Grafana Panel Query
\`\`\`promql
[promql query]
\`\`\`

### PagerDuty/OpsGenie Routing
Who gets paged, under what escalation policy.

ALERT RULES DATA:
${JSON.stringify(alertRules, null, 2)}

Write as ALERT_RULES.md in current working directory.`,
      {}
    );
  }

  log("✅ All output files written");

  return {
    files: [
      "RCA_REPORT.md",
      ...(codeChanges.length > 0 ? ["CODE_CHANGES.md"] : []),
      ...(runbookChanges.length > 0 ? ["RUNBOOK_UPDATES.md"] : []),
      ...(alertRules.length > 0 ? ["ALERT_RULES.md"] : [])
    ]
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

export default pipeline("adversarial-rca", async (ctx) => {
  log("🚨 Adversarial RCA Workflow Starting");
  log("════════════════════════════════════════");

  // Phase 1: Parse incident
  const incident = await parseIncident(ctx);

  // Phase 2: Parallel 5-Why analysis
  const analyses = await parallelAnalysis({ ...ctx, incident });

  // Phase 3: Adversarial reviews
  const reviews = await adversarialReviewPhase({ ...ctx, incident, analyses });

  // Phase 4: Adjudicate root causes
  const synthesis = await adjudicateRootCauses({ ...ctx, incident, analyses, reviews });

  // Phase 5: Build remediations (only for confirmed root causes)
  const remediations = await remediationPhase({ ...ctx, incident, synthesis });

  // Phase 6: Write output files
  const outputs = await writeOutputs({ ...ctx, incident, synthesis, remediations, analyses, reviews });

  log("════════════════════════════════════════");
  log("✅ Adversarial RCA Complete");
  log(`📁 Output files: ${outputs.files.join(", ")}`);
  log(`🎯 Confirmed root causes: ${synthesis.confirmed_root_causes.length}`);
  log(`❌ Rejected claims: ${synthesis.rejected_claims.length}`);
  log(`🔧 Specific remediations: ${remediations.reduce((sum, r) => sum + r.remediations.length, 0)}`);

  return {
    incident_title: incident.title,
    confirmed_root_causes: synthesis.confirmed_root_causes,
    rejected_claims: synthesis.rejected_claims,
    remediations_count: remediations.reduce((sum, r) => sum + r.remediations.length, 0),
    output_files: outputs.files
  };
});
