<!--
Thanks for contributing to gozzle! Please keep PRs focused and describe the WHY,
not just the what. See CONTRIBUTING.md.
-->

## What and why

<!-- What does this change, and why is it needed? -->

## How the read-only / proof guarantees are preserved

<!--
gozzle is read-only by construction and never executes a user's original query.
If this PR touches a tool or query path, explain how that still holds. Write
"n/a" if this change can't affect it (docs, tests, tooling).
-->

## Checklist

- [ ] `npm run format` and `npm run lint` pass
- [ ] `npm run typecheck -w @gozzle/cli` passes
- [ ] `npm test` passes (added/updated tests for new behavior)
- [ ] No writes, DDL, or data exfiltration introduced
- [ ] Docs updated if behavior changed
