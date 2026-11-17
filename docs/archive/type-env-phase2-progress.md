# Phase 2 — Explicit TypeScript `any` removal progress

Branch: `refactor/remove-any-and-obsolete-env-flags`

## Changes committed

| File | Previous escape | Replacement | Count |
| --- | --- | --- | ---: |
| `scripts/backfill-prepaid-rent.ts` | `(e as any).message` | `e instanceof Error ? e.message : String(e)` | 2 |
| `scripts/backfill-inventory-company.ts` | `(countResult.rows[0] as any).cnt` | typed/unknown row property access without `any` | 1 |
| `scripts/backfill-charge-voucher-fk.ts` | `chargeRows[0] as any` | common flat select projection `{id,voucherId}` | 1 |
| `scripts/repair-post-offload-cost-cascade.ts` | `catch (err: any)` | `catch (err: unknown)` with `Error` narrowing | 1 |
| `scripts/repair-factory-commission-fx.ts` | `catch (err: any)` | `catch (err: unknown)` with `Error` narrowing | 1 |

Total addressed: **6 type-escape occurrences** across five files. No rollout flags changed.

## Scope clarification

The repository-wide baseline in `config/type-escape-boundaries.json` has ceiling 0 but applies only to `server`, `client/src`, and `shared`, excluding declaration files. A separate backlog exists in `scripts/` and `tests/`, as demonstrated by explicit `any` in `scripts/repair-factory-commission-fx.ts`, `scripts/repair-post-offload-cost-cascade.ts`, and `tests/helpers/fakeRouteApp.ts`. The previously cited number **21** is not a verified entire-repository count.

## Unresolved

- The complete full-checkout AST audit has not been executed; the generator from Phase 1 must be run to establish exact scope.
- Several other repair scripts contain database and cost-calculation type assertions that require type-aware refactoring, not blind replacement.
- Test-harness types under `tests/` require a separate compatibility review.
- CI, lint, test and TypeScript build execution are intentionally deferred at user request. **Phase 2 cannot be certified done without a complete inventory and at least subsequent verification.**

Run at final verification:

```bash
node scripts/audit-type-env-inventory.mjs
npm run audit:type-escapes
npm run check
npm run lint
npm test
```

## Continued Phase 2 cleanup (2026-11-16)

Additional commits remove explicit `any` from these maintenance scripts:

- `scripts/create-admin.ts`: error narrowed using `instanceof Error`.
- `scripts/init-db-manual.ts`: database error code narrowed structurally, messages narrowed safely.
- `scripts/repair-rental-payment-accounting.ts`: three catch variables use `unknown` with safe message extraction.
- `scripts/smoke-test-csrf.ts`: standard Headers `getSetCookie()` and unknown JSON response token guard.
- `scripts/repair-post-offload-cost-cascade.ts`: infer container/charge/commission types from Drizzle selections, remove update assertion.
- `scripts/repair-factory-commission-fx.ts`: infer commission and container types, remove update assertions and transaction cast; reject missing refreshed container; omit unsupported cascade params.

The 45 tracked `scripts/**/*.ts` paths were individually inspected using the GitHub repository file API and text-pattern searches for `as any`, `catch (...: any)`, `any[]`, and obvious annotations. That is **not** an AST scan and may miss uncommon syntaxes. **Do not represent this as a verified zero count.**

The 1,593 tracked `tests/**/*.{ts,tsx,mts,cts}` files were not exhaustively audited; targeted GitHub search demonstrates explicit `any` in multiple test harnesses. Scope must be explicitly resolved against the stated "last 21" goal before repo-wide Phase 2 can be closed.

**No tests, typecheck, lint or CI have been run**, as requested. Some removed casts may expose legitimate TypeScript schema mismatches which must be fixed before merge.

**Status: In progress, not certified.**
