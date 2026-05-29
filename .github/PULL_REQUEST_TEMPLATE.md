## Summary

<!-- A concise description of what this PR does and why. -->

## Workflow Affected

<!-- Which workflow(s) does this change affect? e.g. adversarial-bugfix, adversarial-review, all, none -->

## Testing Done

<!-- Describe how you tested your changes. -->

- [ ] Ran `node scripts/validate.js` — all workflows load without error
- [ ] Ran `node scripts/check-pkg.js` — package.json is valid
- [ ] Manually invoked the affected workflow(s) against a real repo
- [ ] Verified output files are correct (e.g. BUGS.md, REVIEW.md, etc.)

## Checklist

- [ ] All tests pass (`node scripts/validate.js`)
- [ ] Documentation updated (README.md if applicable)
- [ ] CHANGELOG.md updated with entry under `[Unreleased]`
- [ ] No new external dependencies introduced (pure Node.js only)
- [ ] New workflow follows naming convention: `adversarial-X.js` in `workflows/`
- [ ] Bin entry added to `package.json` if new workflow added
