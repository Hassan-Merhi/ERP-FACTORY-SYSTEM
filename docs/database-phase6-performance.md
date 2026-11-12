# Phase 6 — Database performance and index optimization

## Shipped in the feature branch

- `npm run db:performance:audit`: read-only PostgreSQL telemetry covering table scan counts, estimated live/dead tuples, index usage and size, active lock waits, transaction age and optional `pg_stat_statements` aggregate timings (no SQL text).
- `scripts/database-performance-core.mjs`: deterministic candidate classification without automatic index creation, dropping or modification.
- `tests/database-performance-audit.node.test.mjs`: regression tests for missing stats, scan thresholds, index safety, lock waits and read-only boundary.
- The existing `scripts/collect-program6d-query-plans.mjs` already measures the ledger-related plan paths. The existing `npm run certify:performance-wave5` is the supported live API/browser performance certification path.

## Findings from source inspection, NOT production benchmark results

1. The Factory monthly production matrix endpoint in `server/routes/factory/bale-exports/monthly-production-matrix.ts` joins factory_bales to products with `p.id = b.product_id OR (b.product_id IS NULL AND p.article_code = b.article_code)`, grouping by production month. This may be costly at scale, but a rewrite must preserve the same product matching, company scope, deletion/status filters and counts. Rewrites are **not** approved from static inspection alone.
2. Agent ledger history in `server/routes/accountTransactionRoutes.ts` reads transactions and a separate brought-forward sum. This must be evaluated alongside indexes on `voucher_entries.voucher_id`, ledger account ownership, and the effective-date expression; do not add a composite index without evidence.
3. The repo already uses per-route database telemetry and a live performance budget. Optimization should fit those measures, not replace them with arbitrary pass thresholds.

## Staging / production measurement protocol

1. On a restored production-like database run `npm run db:performance:audit`. The audit uses `BEGIN READ ONLY`; collect stats in a restricted environment and retain only aggregate artifacts.
2. Check the PostgreSQL statistics reset time and wait for representative workload. A zero index scan count is **never** permission to drop an index.
3. Run the existing `node scripts/collect-program6d-query-plans.mjs` with valid scoped test-company settings. It invokes `EXPLAIN ANALYZE`, which executes its SELECT workload even in read-only transactions, so use staging if possible.
4. Capture baseline latency, throughput, lock waits, returned record counts, ledger totals and Factory bale totals. Pay special attention to Agent Ledger and Monthly Production Matrix.
5. Identify the exact query and parameters behind high costs. Propose a candidate query rewrite or index with measured plan evidence. For large tables prefer separately reviewed online/concurrent indexes, since Phase 2's transactional runner correctly prohibits `CREATE INDEX CONCURRENTLY`.
6. After a reviewed change, rerun the *same* query and traffic profile, confirm equal accounting/inventory results, and record before/after execution plans, p50/p95 latency, query count, lock time, and index utilization.
7. Run `npm run certify:performance-wave5` against an authorized deployment to verify browser/API budgets. Roll back the application change if correctness or performance regresses.

## Certification prerequisites not yet met

This phase is **not** production-certified. Live/postgres telemetry, representative query plans, production-sized staging, result-equivalence validation, any justified index deployment, and live p95 measurements have **not** been executed in this session.

Do not claim that long-loading pages are fixed or that the database is optimized until those checks prove it. No production data or indexes were changed.
