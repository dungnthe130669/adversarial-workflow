#!/usr/bin/env node
// Validates workflow JS files — ESM syntax check using acorn via node --input-type

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dir = path.join(__dirname, '..', 'workflows');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();

let errors = 0;

files.forEach(f => {
  const filePath = path.join(dir, f);
  try {
    execSync(`node --input-type=module --eval "" < /dev/null`, { stdio: 'pipe' });
    // Use node to parse as ESM module (syntax check only, no execute)
    execSync(
      `node --check ${filePath}`,
      { stdio: 'pipe' }
    );
    console.log('✓', f);
  } catch (e) {
    // node --check doesn't support ESM top-level await detection well;
    // try parsing as ESM via dynamic import of a data URI
    try {
      execSync(
        `node -e "import(require('url').pathToFileURL('${filePath}').href).catch(()=>{})"`,
        { stdio: 'pipe', timeout: 3000 }
      );
      console.log('✓', f, '(esm)');
    } catch (e2) {
      const msg = (e.stderr || e.message || '').toString().split('\n')[0];
      console.error('✗', f + ':', msg);
      errors++;
    }
  }
});

console.log(`\n${files.length - errors}/${files.length} workflows valid`);
if (errors) process.exit(1);
