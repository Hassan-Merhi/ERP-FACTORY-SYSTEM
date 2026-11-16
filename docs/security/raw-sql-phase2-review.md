# Raw SQL injection review — Phase 2 working findings

Review branch: `security/raw-sql-allowlist-audit`. This file records **manual
source review** conducted against the branch, not a claim that all call sites
have been verified. The initial count of approximately 177 is an estimate.

## Priority 0 — already changed to bound parameters

| File | Tainted/dynamic component | Disposition |
| --- | --- | --- |
| `server/lib/transporterAllocation.ts` | IDs from voucher processing, converted to comma text | Bound with `sql.join(sql\`\${id}\`)` |
| `server/routes/sp/spMigrationPhase2Routes.ts` | Tracked IDs and table name from migration rows | Bound IDs; table names quoted by `sql.identifier` after fixed membership test |
| `server/routes/rental/shared/accrual.ts` | Monthly-ledger IDs and date cutoff | All five previous raw call sites converted |
| `server/routes/transporterStatementRoutes.ts` | Credit/debit entry ID arrays | Drizzle-bound arrays |
| `server/services/rental/rentalPaymentPostingService.ts` | Month ID list | Drizzle-bound IDs |
| `server/routes/rental/shared/accrual-posting.ts` | Accrual row IDs | Drizzle-bound IDs |
| `server/routes/admin/dependentDeletedItemPermanentRoutes.ts` | Catalog-derived schema/table/column and parent ID | Bound ID, `sql.identifier` for catalog identifiers |

## Raw SQL sites observed and preliminary classifications

**Static DDL / literal fragments (no runtime expression in the raw argument):**
`server/routes/sp/spMigrationCutoverState.ts`,
`server/routes/sp/spMigrationCutoverRoutes.ts`,
`server/routes/sp/spMigrationCutoverHardening.ts`,
`server/routes/sp/spMigrationPhase4Inventory.ts`,
`server/routes/sp/spMigrationPhase4Routes.ts`,
`server/routes/sp/spMigrationPhase2Common.ts`,
`server/routes/factory/factoryFrenchTranslationRoutes.ts`,
`server/routes/factory/products/productHistoryRoutes.ts`,
`server/services/reports/agingReport.ts` (base debit/credit fragments),
`server/services/factory/netPositionHistoricalInventory.ts` (requires caller proof),
`server/routes/factory/employee-pos/netPositionInventory.ts`.

**Generated SQL from controlled/validated fragments (needs recorded provenance
before allowlisting):**
`server/lib/factoryCustomerLedger.ts`,
`server/services/accounting/balances/periodReportRules.ts` (alias regex),
`server/services/accounting/balances/partyLineRules.ts` (integer normalization),
`server/services/accounting/balances/unpostedMemo.ts` (union alias),
`server/services/accounting/balances/ledgerBalanceEngine.ts`,
`server/services/accounting/partyOpenItemService.ts` (table chosen by domain),
`server/services/accounting/accountHistoryPolicy.ts` (table/column sets),
`server/services/accounting/monetaryFxValuation.ts` (table chosen by account kind),
`server/services/accounting/cashBankReconciliationService.ts` (bank/ledger selection),
`server/services/accounting/monetaryFxValuationService.ts` (split static SQL placeholders),
`server/services/factory/netPositionAsOf.ts`,
`server/services/factory/productionBalanceOnTable.ts`,
`server/services/factory/netPositionHistoricalPipeline.ts`,
`server/services/accounting/balances/unpostedMemo.ts`,
`server/routes/git/spGitTrackingRoutes.ts`,
`server/routes/git/spGitTrackingImportRoutes.ts`,
`server/routes/suppliers/supplierRepository.ts`,
`server/routes/factory/suppliers/balance/factorySupplierLedger.ts`,
`server/routes/voucher-entries/by-account.ts`,
`server/routes/vouchers/voucherPaginationRoutes.ts`,
`server/routes/factory/factoryDaybookRoutes.ts`,
`server/services/accounting/integrity/ledgerShapeChecks.ts`.

**Needs deeper audit / proposed parameterization:**
`server/services/factoryBilingualSnapshotService.ts` assembles whole raw
queries from schema metadata expressions and numeric scope IDs. It uses
`assertIdentifier` and numeric conversion, but input-source validation and
each expression builder need a separate review. Prefer binding company ID,
product ID and scope IDs; quote generated identifiers.

**Important semantics:** `voucherKnownBy` in
`server/services/factory/netPositionHistoricalPipeline.ts` accepts a string
named `number` and passes it to `sql.raw`. The two observed callers supply
hard-coded SQL expression *strings* (e.g. an `'INV-GL-'` expression and a
`'CHARGE-PRE-'` expression), NOT voucher numbers from a request. This contract
must be preserved or replaced with a typed SQL fragment; do not approve
arbitrary strings to that function.

**Other `sql.raw` call paths requiring per-site review:**
`server/services/accounting/partyOpenItemService.ts`,
`shared/schema/unifiedAccounting.ts`,
`server/services/factoryBilingualSnapshotService.ts`,
`server/services/accounting/balances/ledgerBalanceEngine.ts`.

## Important limitations / remaining Phase 2 work

The search-based review inspected the known GitHub search results for
`sql.raw` (44 files, including tests; paths can overlap). Search does not
prove exhaustive occurrence coverage. In particular, the following are
**not yet audited exhaustively**: dynamic SQL assembled before `pool.query`,
`client.query`, and other indirect database calls; template literals passed
to custom query wrappers; SQL constructed in migrations and auxiliary scripts;
and files that GitHub code search may not index. No full checkout/scan,
TypeScript build, or test-suite execution was available in this session.

For the acceptance criterion, run `npm run check:raw-sql` and the
`--inventory` mode, extend coverage to indirect string assembly, and require
a source-specific approval plus adversarial tests. The allowlist stays empty,
rather than pretending uncertain cases are reviewed. Never merge this draft
until the full inventory is complete.

## Continued review — additional verified code paths

- `server/services/accounting/monetaryFxValuation.ts`: bank/ledger table
  chosen by a literal `account.accountKind` branch; now quoted with
  `sql.identifier(k.table)`. IDs and company scope already bound.
- `server/services/accounting/partyOpenItemService.ts`: table chosen by
  `customer`/`supplier`/`factory_supplier` domain lookup; now uses
  `sql.identifier(table)`, with scoped parameters unchanged.
- `server/services/accounting/cashBankReconciliationService.ts`: the source
  table is chosen only from bank/ledger kinds; now a quoted identifier.
- `server/services/accounting/accountHistoryPolicy.ts`: column is checked
  against `LINE_COLUMNS`, table against `LOCKABLE_TABLES`; both paths
  now use `sql.identifier` rather than SQL text concatenation.
- `server/services/factory/netPositionHistoricalPipeline.ts`: a voucher
  lookup formerly accepted untyped SQL expression strings passed into
  `sql.raw(number)`. The helper now requires a typed `SQL` fragment.
  Both observed expressions are constant tagged-SQL expressions, not
  externally supplied voucher numbers.

A GitHub recursive tree query for this branch returned `truncated=false`
and approximately 6,470 JavaScript/TypeScript source files overall,
including 2,311 under `server`, 263 under `scripts`, 151 under
`shared`, and 1,623 under `tests`. The tree is **path inventory only**;
it does not establish that the contents of all those files were inspected.
The Phase 2 review cannot be certified as exhaustive from GitHub search.

## Expanded detection gate

The checker now also flags SQL-shaped text templates assigned to
`query`/`sql`/`statement`/`ddl`/`text`-named variables. This is a
heuristic that surfaces indirect builders that an immediate
`pool.query(template)` check misses. It **does not** prove full taint flow:
complex query builders and arbitrary variable names can evade this test,
while some flagged strings may be demonstrably safe. All findings still
require manual classification.

The remaining acceptance gate is therefore unchanged: run an exhaustive
inventory against a checkout, inspect each original SQL-value source and
database sink, and produce a complete reviewed allowlist before Phase 2
can be considered complete.
