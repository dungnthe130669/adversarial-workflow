#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const pkgPath = path.resolve(__dirname, '..', 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.error('✗ package.json not found');
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`✗ Failed to parse package.json: ${err.message}`);
  process.exit(1);
}

const required = ['name', 'version', 'description', 'bin', 'files', 'repository', 'license', 'keywords'];
const missing = [];

for (const field of required) {
  if (pkg[field] === undefined || pkg[field] === null || pkg[field] === '') {
    missing.push(field);
  }
}

if (missing.length > 0) {
  console.error(`✗ package.json missing required fields: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`✓ package.json valid — version ${pkg.version}`);
