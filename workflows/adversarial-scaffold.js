
export const meta = {
  name: 'adversarial-scaffold',
  description: 'Design architecture, scaffold codebase in parallel modules, integration review, then adversarial quality gate',
  phases: [
    { title: 'Design', detail: 'Architect designs modules, interfaces, file structure' },
    { title: 'Scaffold', detail: 'Build each module in parallel from spec' },
    { title: 'Integrate', detail: 'Verify modules fit together — interfaces, imports, types' },
    { title: 'Gate', detail: 'Adversarial quality gate on the full codebase' },
    { title: 'Write', detail: 'Write all approved files to disk' },
  ],
}

const ARCHITECTURE_SCHEMA = {
  type: 'object',
  properties: {
    projectName: { type: 'string' },
    description: { type: 'string' },
    stack: { type: 'string' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          exports: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'name', 'files', 'description', 'exports', 'dependsOn'],
      },
    },
    entrypoint: { type: 'string' },
    sharedConventions: { type: 'string' },
  },
  required: ['projectName', 'description', 'stack', 'modules', 'entrypoint', 'sharedConventions'],
}

const MODULE_BUILD_SCHEMA = {
  type: 'object',
  properties: {
    moduleId: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    summary: { type: 'string' },
    exportedSymbols: { type: 'string' },
  },
  required: ['moduleId', 'files', 'summary', 'exportedSymbols'],
}

const INTEGRATION_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          originalContent: { type: 'string' },
          fixedContent: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'originalContent', 'fixedContent', 'reason'],
      },
    },
  },
  required: ['passed', 'issues', 'fixes'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
  },
  required: ['approved', 'issues', 'blockers', 'suggestion'],
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'string' } },
  },
  required: ['written', 'failed'],
}

// Phase 1: Architect designs the full structure
phase('Design')
const specPath = args || './SPEC.md'
const arch = await agent(
  `You are a senior software architect. Read the project spec at ${specPath} and design a complete modular architecture.

Output:
1. projectName, description, stack (language/framework/runtime)
2. Break the project into 3-8 independent modules — each module = a cohesive group of files
3. For each module:
   - id: short slug (e.g. "auth", "db", "api")
   - name: human name
   - files: list of file paths to create (relative to project root)
   - description: what this module does
   - exports: public symbols/functions/classes this module exposes to others (be specific)
   - dependsOn: list of other module IDs this module imports from
4. entrypoint: main file path (e.g. "src/index.ts")
5. sharedConventions: coding style, error handling pattern, naming convention, etc.

Design for minimal coupling. Modules should be buildable independently.
Return raw JSON only.`,
  { label: 'design-architecture', phase: 'Design', schema: ARCHITECTURE_SCHEMA }
)

log(`Project: ${arch.projectName} (${arch.stack})`)
log(`${arch.modules.length} module(s):`)
for (const m of arch.modules) {
  log(`  ${m.id} → files: [${m.files.join(', ')}] | exports: ${m.exports} | deps: [${m.dependsOn.join(', ') || 'none'}]`)
}

// Phase 2: Build each module in parallel
phase('Scaffold')

// Sort by dependency order — build independent modules first
const sorted = [...arch.modules].sort((a, b) => {
  if (b.dependsOn.includes(a.id)) return -1 // b depends on a → a first
  if (a.dependsOn.includes(b.id)) return 1
  return 0
})

const built = await parallel(
  sorted.map((module) => async () => {
    const deps = arch.modules.filter(m => module.dependsOn.includes(m.id))
    const depContracts = deps.map(d => `  ${d.id} (${d.name}): exports ${d.exports}`).join('\n') || '  none'

    return agent(
      `You are an expert ${arch.stack} developer. Build this module from scratch.

Project: ${arch.projectName}
Module: ${module.name} (${module.id})
Description: ${module.description}
Files to create: ${module.files.join(', ')}

Public interface you MUST export (other modules depend on this):
${module.exports}

Modules you can import from (already built):
${depContracts}

Shared conventions:
${arch.sharedConventions}

Rules:
- Write complete, working code — no TODOs, no stubs, no placeholder comments
- Match the shared conventions exactly
- Only export what is listed in "Public interface"
- Do NOT import from modules not listed in your dependency list
- Each file: provide the full file path and complete file content

Return all files as a JSON array.`,
      { label: `scaffold:${module.id}`, phase: 'Scaffold', schema: MODULE_BUILD_SCHEMA }
    )
  })
)

const builtModules = built.filter(Boolean)
const totalFiles = builtModules.reduce((sum, m) => sum + m.files.length, 0)
log(`Scaffolded ${builtModules.length}/${arch.modules.length} module(s), ${totalFiles} file(s) total`)

// Build a flat map of all files: path → content
const fileMap = {}
for (const mod of builtModules) {
  for (const f of mod.files) {
    fileMap[f.path] = f.content
  }
}

// Phase 3: Integration check — do modules fit together?
phase('Integrate')
const allCode = Object.entries(fileMap)
  .map(([path, content]) => `=== ${path} ===\n${content}`)
  .join('\n\n')

const integration = await agent(
  `You are a senior engineer doing integration review. Check that all modules fit together correctly.

Architecture:
- Entrypoint: ${arch.entrypoint}
- Modules: ${arch.modules.map(m => `${m.id} exports: ${m.exports}`).join('; ')}

All generated files:
${allCode}

Check for:
1. Import/require paths — do they resolve correctly? Are relative paths right?
2. Interface mismatches — does a module import a symbol that wasn't exported?
3. Type mismatches — function signatures, argument counts, return types
4. Missing files — does any import reference a file that wasn't created?
5. Circular dependencies
6. Convention violations (${arch.sharedConventions})

For each issue found: provide a fix (file path, original content, fixed content).
If no issues: passed=true, issues=[], fixes=[].
Return raw JSON only.`,
  { label: 'integration-check', phase: 'Integrate', schema: INTEGRATION_SCHEMA }
)

if (integration.issues.length > 0) {
  log(`Integration: ${integration.issues.length} issue(s) found`)
  for (const issue of integration.issues) log(`  ⚠ ${issue}`)
} else {
  log('Integration: clean ✓')
}

// Apply integration fixes to fileMap
for (const fix of integration.fixes) {
  if (fileMap[fix.file]) {
    fileMap[fix.file] = fix.fixedContent
    log(`  Fixed: ${fix.file} — ${fix.reason}`)
  }
}

// Phase 4: Adversarial quality gate — 2 independent reviewers
phase('Gate')
const gatedCode = Object.entries(fileMap)
  .map(([path, content]) => `=== ${path} ===\n${content}`)
  .join('\n\n')

const [gateA, gateB] = await Promise.all([
  agent(
    `You are an adversarial code reviewer. Your job: find real problems in this freshly scaffolded codebase.
Default to approved=false unless the code is genuinely production-ready.

Project: ${arch.projectName} (${arch.stack})
Spec: ${specPath}

Code:
${gatedCode}

Reviewer angle: correctness and completeness.
Check:
- Does the code actually implement what was specced?
- Logic errors, off-by-ones, null/undefined handling?
- Missing error handling for likely failure cases?
- Security issues (injection, auth, validation)?
- Are all exported symbols actually implemented (no stubs)?

List blockers (must-fix) separately from issues (should-fix).`,
    { label: 'gate-correctness', phase: 'Gate', schema: GATE_SCHEMA }
  ),
  agent(
    `You are an adversarial code reviewer. Your job: find real problems in this freshly scaffolded codebase.
Default to approved=false unless the code is genuinely production-ready.

Project: ${arch.projectName} (${arch.stack})

Code:
${gatedCode}

Reviewer angle: architecture and maintainability.
Check:
- Is the module boundary design sound? Or is there hidden coupling?
- Are interfaces minimal and stable?
- Code duplication across modules?
- Missing tests or testability issues (untestable code, global state)?
- Will this scale to the next 10x feature additions?

List blockers (must-fix) separately from issues (should-fix).`,
    { label: 'gate-architecture', phase: 'Gate', schema: GATE_SCHEMA }
  )
])

const gates = [gateA, gateB].filter(Boolean)
const blockers = gates.flatMap(g => g.blockers || [])
const allIssues = gates.flatMap(g => g.issues || [])
const gateApproved = blockers.length === 0

if (!gateApproved) {
  log(`Gate: BLOCKED — ${blockers.length} blocker(s)`)
  for (const b of blockers) log(`  ✗ ${b}`)
} else {
  log(`Gate: APPROVED — ${allIssues.length} non-blocking issue(s)`)
}
for (const issue of allIssues) log(`  ⚠ ${issue}`)

// Phase 5: Write files to disk
phase('Write')
const writeResult = await agent(
  `Write the following files to disk. Use the Write tool for each file.
Create parent directories as needed.

${Object.entries(fileMap).map(([path, content]) => `
--- FILE: ${path} ---
${content}
`).join('\n')}

After writing all files, return:
- written: array of file paths successfully written
- failed: array of file paths that failed`,
  { label: 'write-files', phase: 'Write', schema: WRITE_SCHEMA }
)

log(`Written: ${writeResult.written.length} file(s)`)
if (writeResult.failed.length > 0) {
  log(`Failed: ${writeResult.failed.join(', ')}`)
}

return {
  project: arch.projectName,
  stack: arch.stack,
  modulesDesigned: arch.modules.length,
  modulesBuilt: builtModules.length,
  filesGenerated: totalFiles,
  integrationIssues: integration.issues.length,
  integrationFixes: integration.fixes.length,
  gateApproved,
  blockers,
  nonBlockingIssues: allIssues,
  filesWritten: writeResult.written.length,
  filesFailed: writeResult.failed.length,
  entrypoint: arch.entrypoint,
  modules: arch.modules.map(m => ({
    id: m.id,
    name: m.name,
    files: m.files,
  })),
}
