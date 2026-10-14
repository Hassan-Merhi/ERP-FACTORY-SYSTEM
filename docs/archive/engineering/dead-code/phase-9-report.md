# Phase 9 — Obsolete scripts and build configuration

**Status: COMPLETE.** Branch `refactor/erp-dead-code-cleanup`. No scripts were executed.

## Method

Every file in `scripts/`, `build/` and the repository root was searched for references in
`package.json` scripts, `.github/workflows`, `render.yaml`, other scripts, tests, configs and
operational docs. Every `package.json` script target and every `node scripts/...` call in the
workflows was checked to exist (all do; `build-windows.yml` runs `scripts/generate-icons.js`
inside `desktop/`).

## Removed (8)

| File | Why |
|---|---|
| `scripts/pr1559-self-fix.mjs` | Source patch for one historical PR; its workflow `pr1559-self-fix.yml` was already deleted (see `docs/ci/branch-protection.md`). |
| `scripts/phase3-wire-capacity-locks.mjs`, `scripts/phase3-preflight-patch.mjs`, `scripts/phase3-finalize-creation-locks.mjs` | One-shot generators that rewrote route source with exact-text replacements for the 2026 proforma capacity-lock rollout; the target text no longer exists, so they can only fail. |
| `scripts/phase4-remaining-type-safety.mjs` | One-shot source rewriter for the Phase 4 type-safety wave; already applied. |
| `scripts/apply-phase9-batch-a-streaming.mjs` | One-shot source rewriter for the Phase 9 export streaming batch; already applied. |
| `vitest.revision-policy.config.ts` | Unreferenced single-test runner; its test (`tests/stock-transfer-revision-lifecycle-policy.test.ts`) is already included by `vitest.config.ts`. |
| `delete-safe-branches.sh` | One-shot branch deletion list for a different repository name (`Hassan-Merhi/etshadierp`); no references. |

## Preserved (unreferenced, but operational)

Database repair, backfill, diagnostic and recovery tools are kept, as required:
`backfill-charge-voucher-fk.ts`, `backfill-inventory-company.ts`, `backfill-prepaid-rent.ts`,
`backfill-voucher-entry-customer-id.ts`, `repair-factory-commission-fx.ts`,
`repair-post-offload-cost-cascade.ts`, `repair-supplier28-landed-cost-2026.ts`,
`diagnose-historical-sales-cost.ts`, `inventory-valuation-wave5-dry-run.ts`,
`audit-inventory-mutations.sh`, `audit-inventory-valuation-drift.sql`,
`apply-phase3-heavy-read-indexes.mjs` (concurrent index DDL), `run-production-migrations.mjs`
(documented in `docs/financial-close-and-migrations.md`), `wipe-company12-data.ts`
(documented in the accounting audit), `collect-program6d-query-plans.mjs`,
`reconcile-program6d-net-profit.mjs`, `generate-program6c-inventory-classifications.mjs`,
`enable-local-auth.ts`, `smoke-test-csrf.ts`, `setup-replit-db.sh`, plus root `replit.nix`
and `components.json` (Replit/shadcn tooling).

**Needs owner confirmation:** root `build.mjs` says Render invokes it directly
(`node build.mjs`), while `render.yaml` uses `npm run build` (→ `scripts/build-server.mjs`).
The Render dashboard can override the blueprint, and checking it requires choosing a Render
workspace, so the file was kept. Delete it only after confirming the live build command.
*Confirmed 2026-10-13: the Render service `system` builds with `npm ci && node build.mjs`; `build.mjs` stays.*
