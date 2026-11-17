# Phase 4 — Regression protection for TypeScript escapes and environment examples

Branch: `refactor/remove-any-and-obsolete-env-flags`

## New guards

1. `scripts/lib/env-example-policy.mjs`: reusable declaration parser; rejects duplicate keys inside an individual deployment example and rejects documented keys on the explicitly retired list. Cross-file repeats are permitted (shared subsystem settings).
2. `scripts/verify-env-documentation.mjs`: existing repository CI env audit now invokes the policy and rejects server source consuming retired keys. The original server consumer/documentation coverage check remains in place.
3. `scripts/verify-clean-maintenance-types.mjs`: invokes the established AST-based type-escape counter for nine maintenance files cleared in Phase 2; rejects any new explicit `any`, `as any`, or suppression in them, and fails closed if files go missing. It does **not** claim a zero baseline for all test files.
4. `tests/type-env-regression.node.test.mjs`: seven `node:test` fixtures verify duplicate, retired, cross-file, narrative comment, type escape, clean type, and missing-file behavior.
5. `package.json`: exposes `verify:clean-maintenance-types` and `test:type-env-policy`.
6. `.github/workflows/ci.yml`: repository audit job now runs both new commands alongside `verify:env-docs` and the preexisting `audit:type-escapes` check on pull requests.

## Protection boundaries

- Existing `config/type-escape-boundaries.json` stays unchanged: its zero ceiling covers `server/`, `client/src/`, and `shared/` (excluding declarations).
- The nine newly locked scripts are individually protected without inventing a zero baseline for the rest of `scripts/` or `tests/`.
- Other one-time historical flags remain documented while their retirement/rollback status is unresolved. New retired entries require deliberately updating the explicit retirement policy alongside removing consumers.
- The env policy covers the four examples used by the existing verifier and direct static server variable reads. It does not certify Render dashboard secrets, dynamic keys or all client/automation sources.
- CI fixture execution and full checks were deferred at the owner's request; **the new checks are wired, not yet certified green**.

## Final verification

```bash
npm run verify:env-docs
npm run audit:type-escapes
npm run verify:clean-maintenance-types
npm run test:type-env-policy
npm run check
npm run lint
npm test
npm run build
```

Before merging, reconcile current main, confirm the new checks pass in PR CI and investigate any unexpected script/test `any` occurrences from the Phase 1 audit inventory.
