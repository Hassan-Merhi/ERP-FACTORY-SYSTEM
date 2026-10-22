# Phase 9 — Factory Net Position Historical Date Filter: Final Source Review and Claude Handoff

**Repository:** `Hassan-Merhi/ERP-FACTORY-SYSTEM`  
**Unmerged working branch:** `feature/factory-net-position-historical`  
**Scope:** Factory Mode / Net Position, including ERP ledger-linked Factory balances and Properties/FACTORY rentals.  
**Status:** Source-level integration and verification *preparation* complete; **NOT** type-checked, CI-checked, run in an app, reconciled on a database, merged, rebased, or deployed.

## Owner's non-negotiable restrictions

- Keep Phases 1–9 on `feature/factory-net-position-historical`. Do not merge, rebase or deploy without a new instruction.
- **Never create, delete, reverse or edit production accounting vouchers** to make historical figures reconcile. No production data modifications, even if a test shows a mismatch.
- Date filter = business date **AND** the transaction/event actually recorded by the selected company-local end of day. A transaction entered on Oct 21 and backdated to Oct 19 must **not** change the Oct 19 known-at-cutoff snapshot.
- Preserve today's working Factory Net Position figures, ERP ledger rules, Supplier Pool currency conversions, Rental module posting rules and Cost/Selling settings.
- A historical snapshot can add up internally without being financially correct. Keep `historyCompleteness: "partial"` when older audit records or source values are missing.

## Phase 9 source review completed

The implementation now exposes a single historically scoped response through:

- `server/routes/factory/employee-pos/employeeNetPositionRoutes.ts` (main response, company, dates, FX, categories, evidence, 503 fail-closed)
- `shared/factoryNetPositionAsOf.ts` + `server/services/factory/netPositionAsOf.ts` (company-timezone start/end, effective + recorded)
- `netPositionEmployees.ts`, `netPositionHistoricalAssets.ts`, `netPositionHistoricalInventory.ts`, `netPositionHistoricalPipeline.ts`, `netPositionHistoryCoverage.ts`
- `netPositionHistoricalCorrection.ts`, `netPositionReportTotals.ts` and `netPositionHistoricalIntegrity.ts` (dated row projection, grouped totals, signed amounts and consistency assertions)
- Both `FactoryNetPosition.tsx` and `FactoryNetPositionDetails.tsx`, including custom views, hidden accounts, payroll drilldown and Cost/Selling selection.

This final review also patched: rejection of missing/NULL evidence counts (a NULL cannot mean zero missing records); normalization of manually configured FX currency keys; additional qualified receipt/mix-source coverage checks; visible warning that historical Balance on Table may lack removal/repack event times; and an explicit error cause if historical evidence scanning fails. These are source changes, **not runtime-proven fixes**.

**Schema review:** `customer_order_bales.scanned_at` and `customer_order_bales_history.scanned_at` are installed via `server/customerOrderBaleScanAuditBridge.mjs`, not the original schema definitions. The historical endpoint verifies the actual columns first. The startup bridge intentionally leaves older unknown scan times NULL. `factory_container_receipts` is populated by its separate startup schema. `factory_bales.total_cost`, `factory_bale_products.selling_price`, and rental billing-day helpers exist in the source model. Do not assume they exist in a particular deployed database without checking.

### Source behavior to preserve

- Today: unchanged main-date endpoint valuation and current employee cache/rent report semantics.
- Prior date: no silent fallback to current values, even on SQL errors; the endpoint should return a structured `503 HISTORICAL_NET_POSITION_UNAVAILABLE`.
- Supplier balances: existing multi-currency pool and broker rules. Historical master edits/broker relationship history are not all versioned.
- Customer balances: posted voucher entries and known-at-date memos; no unfinalized future freight posted as receivable.
- Raw Materials: individual receipt/adjustment/mix-source replay; legacy cumulative balances are flagged provisional.
- Stock in Hand: bale stock/press dates and scan/cancel audit. Catalog selling prices and later recosting can remain unversioned.
- OTW: per-receipt remaining quantity; some earlier master prices/freight edits are unversioned.
- Pending/Loading/Verified: known scans and recorded workflow transitions; do not copy today's total. Pending is informational and not added to What We Have.
- Assets, rental and worker advances: due rent and posted payments/repayments by cutoff; protect voucher-backed accounts created later.
- Net Position: signed What We Have minus signed What We Owe; both headers, all category groups and exposed per-source fields reconciled to displayed cent-rounded rows.
- UI: company-scoped queries and hidden row preferences, date-aware employee breakdown that cannot hide the aggregate unless reconciled to the cent.

## Mandatory Claude verification sequence — **not executed in Phase 9**

Run these *only when separately requested*, in an isolated branch checkout with nonproduction test credentials. Use `npm run check` (TypeScript) followed by targeted backend Vitest and frontend checks before attempting the full suite. The existing package scripts include `npm run check`, `npm run test:backend`, `npm run test:frontend`, `npm run build`, and `npm run lint`.

**Priority order for investigation if the first type check fails:**

1. Actual Drizzle column/type parity for runtime-added scan audit columns, all historical report response and `historyCoverage` types, and SQL-template interpolation.
2. The historical rental billing helper (returns ISO `YYYY-MM-DD` strings); verify expected/paid precision and `posting_status = POSTED` at prior dates.
3. Historical OTW conversion and supplier statement FX: manual rates must have `created_at` by cutoff as well as `effective_date`; verify currency casing and no missing rate replaced with 1.
4. Exact-cent structural invariant, especially omitted zero rows and category-group fields after `reconcileHistoricalPosition`.
5. Cost/selling historical bale valuation: no catalog edit back-propagated as a claim of historical precision; the warning is required.
6. Reopened order transitions and scans cancelled/restored later: `scanned_at` and `cancelled_at` are `timestamptz`, while most Factory `created_at` timestamps are naive UTC.
7. Each company uses its own time zone. Check the next-midnight cutoff on a daylight-saving transition day in addition to regular October dates.
8. Ensure no special manual tests accidentally POST, finalize, delete, adjust or create vouchers in production.

## Manual verification matrix (read-only snapshot / test fixtures)

For one chosen Factory company, select **Oct 19**, **Oct 20**, **Oct 21**. Snapshot `/api/factory/net-position?asOf=YYYY-MM-DD&valuationMode=cost` and repeat with `valuationMode=selling` in an authorized staging/test context. Copy each snapshot's `companyId`, `asOf`, `timeZone`, `historyCompleteness`, `historyCoverage`, source totals, account arrays and category breakdowns into an offline reconciliation sheet. **Do not create vouchers or edit financial records.**

| Domain | Oct 19 | Oct 20 | Oct 21 | Pass criterion |
| --- | --- | --- | --- | --- |
| Future-created account/customer/supplier | Missing before recorded creation | Same unless created | Present only once actually recorded | No backdated master leaks |
| Customer invoice/voucher recorded Oct 21 with effective Oct 19 | Excluded | Excluded | Included | Both recorded and business time |
| Manual FX entered Oct 21 with effective Oct 19 | Old known rate remains | Old known rate remains | Later entered rate used | No backdated FX knowledge leak |
| Supplier payment/FX transfer recorded Oct 21 and dated Oct 19 | Not deducted | Not deducted | Deducted once | Currency pools retain signs and rates |
| 10,000kg container; first receipt 4,000kg Oct 20, rest Oct 21 | 10,000kg OTW | 6,000kg OTW | 0kg OTW | OTW uses qualifying receipt events |
| Raw material mix consumes 25kg Oct 20 | Full older raw stock | 25kg lower if events known | Continues chronologically | Never reverse current `used_kg` |
| A bale pressed Oct 21 | Not in stock | Not in stock | Eligible if unallocated | Stock entry/press cutoff |
| Bale scanned Oct 21 into earlier order | Still available Oct 19 | Still available Oct 20 | Moves to order or finalization | No double count in stock/order |
| Scan cancelled Oct 21 / undated restore | Earlier active interval remains allocated | Ditto | Cancelled; restore unproven if not dated | Missing provenance warned |
| Verified loading finalized Oct 21 with chosen shipment date Oct 19 | Not finalized/verified early without recorded event | Same | Later transition recognized | Recorded workflow date prevails |
| Employee advance $100 created Oct 19, $20 repaid Oct 20, $30 Oct 21 | $100 | $80 | $50 | Uses original amount and dated repayments |
| Rent due / rental payment posted Oct 21 backdated to Oct 19 | No payment reduction | No payment reduction | Payment applied if actually posted | Contract and posting cutoffs |
| Ledger loan/deposit created Oct 21 | Absent | Absent | Eligible | No future opening in earlier report |
| Cost vs Selling toggle | Only historical stock valuation changes | Ditto | Ditto | Balance on Table stays at cost |
| What We Have / Owe / Net Position | Sum of same signed account rows | Ditto | Ditto | Identical cents in UI and API |
| Payroll breakdown | Matches parent `asOf`, `companyId`, and amount | Ditto | Ditto | No inconsistent hidden liability |

**Independent numerical proof:** Cross-check individual voucher IDs/dates, receipt IDs, bale references and scanned_at, advance IDs/repayments, and contract/payments against source tables or immutable originals. Do not merely compare two report fields derived from the same buggy function. Capture any divergence with source ID, company ID, as-of cutoff, expected, actual, original recorded/effective time, and relevant category warning.

### SQL, migration and performance

- **Unexecuted read-only worksheet:** `scripts/sql/factory-net-position-historical-readonly-audit.sql`. Review parameter placeholders, read-only transaction limits and prerequisites before running against an explicitly approved target. Never run it as a DML repair.
- **Unapplied optional indexes:** `scripts/sql/factory-net-position-historical-indexes.sql`. Review existing indexes and planner stats; concurrent index creation is still a DB mutation and requires separate approval. Do not auto-run startup schema/migration scripts to prepare a database as part of review.
- **No synthetic backfills:** Missing scan times, historical supplier master edits, archived voucher deletions, cost changes and status transitions must stay flagged until *actual documentary or immutable event* evidence supports an adjustment.

## Release status / blockers

**Source implementation is prepared for Claude verification. NOT release-approved.** The following are intentionally unresolved until tested with approved access:

1. **No TypeScript compile, build or automated test evidence** on this branch by owner instruction. Check all new SQL and render types before any release.
2. **No live/staging evidence counts:** `historyCoverage` may reveal new blockers once it is queried on a real database. This work did not query customer data or financial balances.
3. **Legacy event incompleteness:** pre-audit `scanned_at` gaps, supplier relationships, account openings, mutable container costs, bale removal/repack timestamps and rental void history have no complete originals.
4. **Historical balances are NOT certified:** `historyCompleteness` remains `partial` even when API structural sums match. Do not promote to `complete` without auditable source reconciliation.
5. **Branch divergence:** fetch and compare `main` when future merge approval is given; do not automatically rebase now. An unrelated `main` update might overlap accounting routes.

## Suggested prompt to Claude (future, not executed here)

> Review `feature/factory-net-position-historical` and read `docs/archive/factory-net-position-phase1-audit.md` through `docs/archive/factory-net-position-phase9-handoff.md`. Run TypeScript, targeted and full CI in your approved nonproduction checkout. Repair all compile/runtime/SQL discrepancies on the SAME feature branch; independently reconcile selected dated source transactions using approved **read-only** access, including the Oct 19/20/21 scenarios above. Preserve historical *known-at-cutoff* semantics and the current-day numbers. Do not invent missing transactions, silently substitute today's balances, edit production accounting vouchers, apply DB indexes/migrations, merge, rebase or deploy without explicit approval. Provide a ranked list of unresolved historical-data limitations and a clear pass/fail release decision.

**Phase 9 restrictions obeyed:** No test execution, CI, merge, rebase, deploy, production voucher changes, SQL execution, migration, index application or production financial-data read/write.
