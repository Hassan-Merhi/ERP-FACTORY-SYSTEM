# Factory Net Position — historical date filter

**Branch:** `feature/factory-net-position-historical` (not merged, not deployed)
**Code:** `server/routes/factory/employee-pos/employeeNetPositionRoutes.ts`, `server/services/factory/netPosition*.ts`, `shared/factoryNetPositionAsOf.ts`, `client/src/pages/factory/FactoryNetPosition*.tsx`
**History:** the nine implementation phases are archived as `docs/archive/factory-net-position-phase1-audit.md` … `phase9-handoff.md`. Where those records disagree with this page, this page describes the code as it now stands.

## The contract

`GET /api/factory/net-position?asOf=YYYY-MM-DD&valuationMode=cost|selling`

- Without `asOf` the report is **today** in the company's timezone (`company_settings.timezone`, UTC when unset). Today's figures are the unchanged live report.
- A past `asOf` is a **known-at-cutoff** snapshot. A row counts only when its business date is on or before `asOf` **and** it was recorded before the start of the next company-local day. A voucher entered on Oct 21 and dated Oct 19 is not in the Oct 19 or Oct 20 snapshot.
- A future or impossible date is `400`. Any failure while building a past date is `503 HISTORICAL_NET_POSITION_UNAVAILABLE`. Today's balance is never substituted.
- Past dates always report `historyCompleteness: "partial"` and `historyCoverage.certified: false`, plus named `historyWarnings` and counted `historyCoverage.gaps`.
- `created_at`-style columns are `timestamp without time zone` holding UTC. `customer_order_bales[_history].scanned_at` and `cancelled_at` are `timestamptz`. The cutoff helpers in `server/services/factory/netPositionAsOf.ts` convert the local next-midnight correctly on daylight-saving days.

## Design rule: a past date uses today's valuation rules

Each category applies the live report's own rule to the state that existed that day. The main tool is this: **a row last updated before the cutoff still has the values it had then.** Only rows changed later are rebuilt from dated events. As a result, the report for "yesterday" equals today's report whenever nothing was recorded since. The database test checks this.

| Category | Today's rule | How a past date applies it |
| --- | --- | --- |
| Ledger accounts (cash, bank, loans, deposits, other assets/liabilities, prepaid lines) | Posted, non-optional vouchers' lines per account, same classifier and exclusions | Accounts, vouchers and lines recorded by the cutoff and not yet deleted. If **every** line of a voucher post-dates the cutoff (an edit deletes and re-inserts lines), the voucher still counts, at its edited amounts, and is counted in coverage. Lines added later to a voucher that already had lines stay out. |
| Customers (receivable / credit) | Ledger plus unposted memo, Parties formula | Same engine with `knownAt`: vouchers by both dates, memo invoices from finalization by the cutoff, customers created by then |
| Suppliers, brokers, linked suppliers, overpayments | Settlement pools / broker statement (multi-currency) | Containers, charges, payments, FX transfers and vouchers recorded by the cutoff. Manual FX rates must be **entered** by the cutoff. |
| Employee Payroll Payable / receivables | `employees.current_balance` of active employees | Opening balance plus voucher lines (`employee_id` or legacy `EMP-<code>`), same active population. The payroll breakdown uses the same loader and returns `companyId`. |
| Worker advances | `SUM(remaining_balance)` | Original amount, minus dated repayment rows, minus payroll advance deductions without a repayment row (oldest first, as payroll generation does) |
| Prepaid Rent | ACTIVE contracts on active FACTORY units, `|expected − posted|` | Same rule. A contract that is no longer ACTIVE counts only while its term covered the date. Payments must be recorded and posted by the cutoff. |
| Factory Raw Materials | Remaining kg × supplier locked rate (landed cost for unassigned) | Receipt, adjustment and mix-source replay to remaining kg. Valued at the locked rate when the supplier had no later receipt (the rate moves only at offload); otherwise at the replayed moving-average cost, flagged. |
| Stock in Hand | IN_STOCK bales not on an open/completed order, at catalogue cost or selling price | A bale row unchanged since the cutoff uses its status. A changed one is rebuilt: entered stock at `finalized_at`; left it through a dated scan on a live order, a legacy untimed scan (see below), a dated waste dispatch, or deletion. |
| Balance on Table | Mix weight − bale weight (excluding DELETED/REMOVED/REPACKED) at the cumulative batch rate | Batches recorded by the cutoff, minus top-up source rows recorded later. The same bale exclusions apply only where the status was already set by the cutoff. |
| Factory Stock OTW | PENDING / IN_TRANSIT / ARRIVED containers at final payable (else rate × kg) + freight + commission + other charges | In transit until a receipt is known by the cutoff. A container offloaded later is valued from its pre-offload charge snapshot. **A partial receipt ends OTW, exactly as today** (no remaining-kg share; owner decision 2026-10-21, superseding the 6,000 kg expectation in the Phase 9 handoff). |
| Verified / Loading orders (pending is informational only) | Current status, `grand_total` | Stage from recorded transitions (daybook `ORDER_VERIFIED` / `LOADING_SUBMITTED` created by the cutoff, `loading_started_at`). An order row unchanged since the cutoff keeps its stored status and `grand_total`; a changed one is valued at its dated and legacy untimed scans, without charges. |

**Double counting.** A scanned bale leaves Stock in Hand from its scan time and appears only through its order. A received container leaves OTW and becomes raw stock and a supplier payable. Mix consumption moves raw material to Balance on Table, and pressing moves it on to bales. Customer-linked and legacy `EMP-` ledger accounts are excluded from the ledger rows, because their movement is shown on the customer or employee row. The integrity guard (`netPositionHistoricalIntegrity.ts`) rejects a past-date response whose headers, categories, source fields and order lists differ by a cent.

**Legacy untimed scans.** `scanned_at` is filled by a trigger that did not exist before scan times were recorded. A scan without a time counts as made by the cutoff only when its order was created before the company's first timed scan, that first timed scan was itself recorded by the cutoff, and the bale has no cancel/restore history on that order. Any other untimed scan stays unknown. No time is invented: this is a lower bound, because the row existed before tracking began.

**Cost/Selling.** Only Stock in Hand changes (catalogue production price vs selling price). Balance on Table stays at cost.

## Verification on this branch (2026-10-21)

Run in a local, disposable PostgreSQL 16 built the way CI builds it (`drizzle-kit push`, one startup-migration boot), never against production.

- `tests/factory-net-position-historical.database.test.ts` seeds one Asia/Beirut company and checks, for Oct 19 / 20 / 21:

  | Scenario | Oct 19 / 20 / 21 |
  | --- | --- |
  | Cash | 1,200 / 1,250 / 1,690 |
  | Loan | 1,000 / 1,050 / 1,550 |
  | Late account | absent / absent / 40 |
  | Customer invoice entered Oct 21, dated Oct 19 | 0 / 0 / 300 |
  | Payroll payable | 300 / 300 / 200 |
  | Worker advance | 100 / 80 / 50 |
  | Prepaid Rent (100 due Oct 1; 60 dated Oct 15, posted Oct 20) | 100 / 40 / 40 |
  | OTW (EUR rate entered Oct 21 ignored before then) | 6,400 / 1,100 / 1,200 |
  | Raw material | 0 / 1,875 / 4,875 |
  | Balance on Table | 0 / 125 / 75 |
  | Stock in Hand (selling mode: 120) | 80 / 80 / 80 |
  | Verified orders | 0 / 0 / 70 |
  | Loading orders | 70 / 70 / 60 |
  | Supplier payment entered Oct 21, dated Oct 19 | lowers the balance only from Oct 21 |

  It also checks:
  - headers, categories and rows reconcile to the cent in both modes, including today;
  - Oct 22 equals today in every figure;
  - the payroll breakdown equals its parent row for the same company and date;
  - a future date and an impossible date are rejected.
- **Today unchanged:** the same fixture's live report is identical to `origin/main`'s, in both modes, apart from the added metadata fields. So is the report-characterization fixture.

## Read-only check against production (2026-10-21)

The owner authorized `SELECT`-only queries (each in a read-only transaction) on the production database for the factory company (id 12, "HMD INT GROUP - BEIRUT"). Nothing was written.

- **Timezone not set.** `company_settings.timezone` is empty, so every cutoff is UTC midnight (02:00–03:00 in Beirut). Setting it to `Asia/Beirut` is an owner decision; it was not changed.
- **Backdated vouchers** (dated on or before a day, entered after it): 13 for Oct 19 and 12 for Oct 20. The largest are `INV-GL-12-168` (customer invoice 32,485, dated Sep 22, entered Oct 21), `INS-2026-09` (insurance accrual 1,690.66, dated Sep 1, entered Oct 20), and twelve container-charge journals `FACTORY-POC-*` (dated Aug 13 to Oct 19, entered Oct 21). They are correctly absent before the day they were entered.
- **Receipts and OTW**: receipts for containers CMAU3958580 (Oct 19), ECMU5477380 (Oct 20) and SEKU5800740 (Oct 21). In transit: 7, 11 (four new containers created Oct 20) and 10 containers.
- **Defect found and fixed**: orders 140 and 149 were verified on Oct 19 and Oct 20 and invoiced on Oct 21. All 1,210 of their scans pre-date scan-time tracking (the first timed scan is 2026-08-31). Before the legacy rule, these orders were valued at 0 and their sold bales counted as stock. With the rule, Verified orders on Oct 19 and Oct 20 rise by 65,515 (scanned value 33,880 + 31,635; the charges in `grand_total` are not versioned) and Stock in Hand at cost falls by 44,226. The database test now covers this case.
- **Not checked**: the full report could not be run against production from here (no application connection), so complete Oct 19–21 totals are still unverified. A run on a production copy is needed to certify them.

## Known limitations (stay `partial`; do not backfill)

These have no surviving original values. The report keeps them flagged and invents nothing.

1. **Voucher edits** delete the original lines. An edited voucher shows its edited amounts on earlier dates (coverage `HISTORICAL_COVERAGE_VOUCHER_EDITED_LATER`). Hard-deleted vouchers, repayments, supplier payments and FX rates vanish from history.
2. **Catalogue prices, container masters** (kg, rate, charges, currency), **bale costs, order line prices and rent expected amounts** are unversioned. A past date uses the current values, or the pre-offload snapshot for containers.
3. **Bale status without a dated event**: untimed scans outside the legacy rule above; undated restore of a cancelled scan (the restore re-inserts the original scan time and deletes the archive row); removal, repack or swap without a timestamp; stock entry without `finalized_at`.
4. **Order lifecycle**: re-verification deletes and rewrites the `ORDER_VERIFIED` daybook entry, and un-verify deletes it. An invoice reverted later does not appear as finalized in between.
5. **Flags with no history**: employee and unit `active`, contract `status`, customer/supplier soft-delete restores, supplier–broker links, ledger opening balances and types, the locked supplier rate between offloads.
6. The business-date part of some cutoffs uses the UTC date of a timestamp (`offloaded_at::date`, invoice date). This is off by a day only for events within the UTC offset of midnight.

## Not done, needs separate approval

- **Indexes.** `scripts/sql/factory-net-position-historical-indexes.sql` was not applied. Run `EXPLAIN (ANALYZE, BUFFERS)` on a replica first; the highest-value candidates are `voucher_entries (voucher_id, created_at)`, `customer_order_bales (bale_id, scanned_at)`, `customer_order_bales_history (bale_id, cancelled_at)`, `factory_container_receipts (company_id, container_id, created_at)` and `factory_mix_batch_sources (mix_batch_id, created_at)`.
- **Startup preload in CI.** CI boots `node dist/index.js` without `server/startupPreload.mjs`, and the scan-audit bridge skips itself under `NODE_ENV=test`. CI therefore runs `ensureCustomerOrderBaleScanAudit()` explicitly after the startup migrations ("Install production scan-audit schema"), so the `scanned_at` columns exist before any backend test runs. The other preload bridges are still not exercised in CI.
