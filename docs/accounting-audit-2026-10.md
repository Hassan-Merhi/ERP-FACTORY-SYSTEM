# Accounting Audit — October 2026

Scope: the whole accounting path (transaction → API → service → database → voucher →
voucher lines → account → balance → report), checked against the production database
(Render Postgres `dpg-d75mfh0ule4c73ctksfg-a`, service `srv-d6kibgtactks739u7vl0`,
deployed commit `7a307d0` = `main` at audit time). Every production figure below was
produced by a read-only query on 2026-10-06.

## 1. Accounting architecture (as built)

| Layer | Reality |
|---|---|
| Ledger | `vouchers` (header) + `voucher_entries` (lines). Lines target **one of** `ledger_account_id`, `bank_account_id`, `fixed_asset_id`, `supplier_id`, `employee_id`, `customer_id`, `factory_supplier_id`. Parties are posted to directly — there are **no AR/AP control accounts**. |
| Amounts | `debit_amount`/`credit_amount` numeric(20,2) are meant to hold USD base. Dual-currency columns (`transaction_*`, `base_*`, `historical_exchange_rate`, `rate_convention`) are filled by trigger `normalize_voucher_entry_currency_amounts` for USD/CFA; other currencies are left un-normalized. |
| Factory | `factory_daybook_entries` is a **single-sided event log** (one signed amount, no accounts). Factory revenue, receivables, inventory and supplier payables are recomputed from operational tables. |
| Inventory | Only in the `inventory` sub-ledger. Purchases are **expensed** (Dr Purchases/Cr supplier); sales post Dr Cash/Cr Sales with **no COGS**; stock adjustments post one side only. |
| Openings | Stored on master rows (`ledger_accounts`, `customers`, `suppliers`, `employees`, `bank_accounts`), outside any journal. |
| Reports | No trial balance route. "Net Position" and "Import Cycle Balance" mix GL balances with operational tables. A balance-sheet service exists but is unused and incorrect. |
| Isolation | RLS on `vouchers`, `voucher_entries`, `ledger_accounts` (`erp_company_scope_matches`), `company_id` synced from the voucher by trigger. |
| Close | `fiscal_period_closures` enforced by DB triggers on vouchers and lines (no periods are closed in production). |
| Schema delivery | Boot-time DDL in `server/startup-schema/*.ts` and `server/startup/runServerStartupMigrations.ts`. `migrations/*.sql` are not executed by any wired runner; `schema_migration_history` does not exist in production. |

## 2. What is correct

- A real validated posting engine exists (`postBalancedVoucherTx`, `centralPostingEngine.ts`): ≥2 lines, one side per line, one target per line, Decimal balance check, company ownership, idempotency via `accounting_posting_requests`, in-transaction audit.
- Per-line DB checks (no negative, not both sides, not both zero) for normalized lines; historical rate is stored per line and locked on later edits.
- Closed-period triggers cover every voucher and line mutation path.
- RLS + company-id sync trigger give strong row-level tenant isolation.
- POS sales are idempotent (`(company_id, client_sale_id)` unique), many POSTs require an idempotency key.
- Vouchers are soft-deleted by the main delete route; an exact-reversal service exists.
- Recent work moved most money arithmetic to exact decimals.
- Production sales, purchase, payment, receipt and journal vouchers balance (all unbalanced posted vouchers are stock-adjustment types).

## 3. Production findings (read-only, 2026-10-06)

| # | Finding | Evidence |
|---|---|---|
| P1 | **Hidden balancing plugs.** `GET /api/stats/import-cycle-balance` upserts `system_settings.equity_adjustment_<company>` = −difference on every read and then reports 0. | Stored plugs: co 12 **−26,823,525.03**, co 1 **−6,029,171.62**, co 13 **+1,536,142.93**, co 8 −675,219.81, co 17 −159,122.15, co 10 −79,950.71, co 9 +4,557.99, co 7 −116.69 |
| P2 | Unbalanced posted vouchers: 179 stock-adjustment vouchers (Consumption/Mixed/Production), mostly single-line. | net Dr−Cr: co 1 −2,265.86, co 8 +2,225.30, co 9 −147.52, co 10 +40.36, co 17 −767.99 |
| P3 | Opening balances are unbalanced and outside the journal. | co 1 openings Dr 3.71M vs Cr 11.79M; co 13 Dr 6.03M vs Cr 0; co 10 Dr 0.17M vs Cr 0.67M |
| P4 | Live lines posted to **soft-deleted accounts**. | 352 lines; co 10 accounts deleted 2026-09-01 with Jan–Aug history: GC#1 STOCK 785,676; Purchases 464,308; GC PROFIT 176,668; Duties 52,290; Transport 53,210 … |
| P5 | Live lines referencing **hard-deleted accounts** (no FK). | 19 lines → account ids 918, 922, 993, 1002, 450, 2135 (rent accruals, AP clears, CN), June–July 2026 |
| P6 | **Cross-company account references.** | 9 lines: company 1 vouchers posting to company 13 property accounts (Jan–Jun 2026) |
| P7 | Lines with **no target account**. | 14 live lines, e.g. 13 factory "Freight expense" debits (Jul–Sep 2026, ≈39,419) — expense posted to nothing |
| P8 | Factory EUR/AUD vouchers store **native amounts in the USD column**. | 462 lines (co 12) without currency normalization; e.g. AUD 9,000 freight booked as 9,000 not 6,750. ≈ +82k (AUD) / −122k (EUR) USD misstatement, still being written (2026-10-03) |
| P9 | Employee cached balance ≠ ledger. | co 1: 32 of 63 employees differ (cache 87,726 vs ledger 271,636); co 8: 3 differ. Net Position reads the cache. |
| P10 | Chart of accounts is free-form and inconsistent. | `EQUITY`/`EXPENSE`/`LIABILITY` upper-case types, `Indirect Income`/`Intercompany` outside the app enum; "Factory Raw Material Stock" and "RAW MATERIALS" typed Indirect Expense; "Insurance Expense" typed Loans; customer account typed Income; most companies have no equity, retained-earnings or COGS account; DOHA (retail) has 0 accounts, Zambia 3. |
| P11 | Boot-time repairs re-point posted entries on every boot (not one-shot). The stock-adjustment merge has 8 live candidate accounts (companies 1, 7, 8, 9) and ran partially for company 10. | `runServerStartupMigrations.ts` StockAdjFix / CreditNoteVarianceFix (4 candidates) / BonusExpFix; `007` GUAR-CASH debit/credit swap; `009` duplicate-name merge with hard DELETE |
| P12 | Factory revenue is not in the GL. | co 12: 61 customer-order INVOICE daybook events (1.82M) vs 1,095 of GL income |
| P13 | Migration runner drift. | `scripts/run-production-migrations.mjs` documented as the deploy path, but `schema_migration_history` does not exist; schema comes from boot DDL. Render build command (`npm ci && node build.mjs`, plan standard, autoDeploy off) differs from `render.yaml`. |
| P14 | Logs | Error-level logs for the last 7 days show no posting failures (only `/api/factory/shipping-availability` 500s and tenant-scope denials). Render's log search was unavailable for the targeted accounting search. |

## 4. Code findings (ranked)

### CRITICAL
1. **Plug writers**: `import-cycle/balance.ts` (every GET, fire-and-forget), `admin/repair/equity.ts` (two routes), `ledger/initialize-balances.ts` (rewrites the first "Profit" account's opening balance or creates `CAP-001` so that assets equal liabilities).
2. **Boot-time history rewrites** without one-shot guards or transactions (P11).
3. **Voucher edits drop sub-ledger links and skip balance checks**: `PATCH /api/vouchers/:id` deletes all lines and re-inserts without `customerId`/`factorySupplierId`, with no balance check, and can activate an unbalanced optional voucher. `PUT /api/vouchers/:id/with-entries` does the same outside a transaction. `POST/PATCH /api/voucher-entries` and `transfer-account` mutate lines with no balance check.
4. **No ledger-level referential integrity**: no FK on `ledger_account_id`/`bank_account_id`/`fixed_asset_id`; nothing stops posting to a deleted or other-company account, or deleting an account that carries history.
5. **No database balance invariant**; ~70 writer files bypass the validated engine.
6. **GL has no inventory/COGS**; stock adjustments are one-sided by design; factory sales never reach the GL.

### HIGH
7. No chart-of-accounts template: company creation creates no accounts; ~25 lazy find-or-create helpers by name/code with conflicting types (`EXPENSE` default, `FACTORY_CHARGES_PAYABLE` typed EXPENSE), racy `MAX+1` codes, and a regex bug (`'^\d+$'` inside `sql\`\`` becomes `'^d+$'`).
8. Factory foreign-currency vouchers write native amounts into the base column (P8); factory FX lookup uses the latest manual rate regardless of date; no FX gain/loss accounts.
9. Non-atomic posting: container create, PO create, payroll pay, supplier FX transfers, daybook writes outside the transaction; side effects swallowed after commit.
10. At least ten independent balance engines with conflicting opening-side, optional/deleted filters, date and company-scope rules.
11. Payroll: one generator posts no accrual; "mark PAID" in factory payroll update posts no cash voucher; advance delete leaves repayment vouchers.
12. Intercompany: mirror voucher only on approval, no currency, name-pattern parent matching, name-based "elimination".

### MEDIUM
13. Global (not per-company) voucher numbers from `Date.now()`; racy per-company sequences.
14. Per-line CFA rounding can unbalance a voucher by a cent.
15. `financial_periods` close/reopen has no callers (only `fiscal_period_closures` is enforced).
16. Optional vouchers counted in customer balances and the ratios report.

## 5. Score (before remediation)

| Category | Score |
|---|---|
| Chart of Accounts | 20 |
| Double Entry | 35 |
| General Ledger | 25 |
| Posting Engine | 40 |
| AR/AP | 30 |
| Inventory | 15 |
| Factory Accounting | 15 |
| Multi-Currency | 40 |
| Multi-Company | 55 |
| Reporting | 10 |
| Data Integrity | 30 |
| Audit Trail | 40 |

**CURRENT ACCOUNTING SCORE: 28/100**

## 6. Remediation waves

See the "Wave log" section of this file for status; each wave lists goal, problems,
risk, modules, database and production impact, dependencies and acceptance criteria.

## Wave log

### Wave 1 — Stop hidden plugs and boot-time history rewrites (CRITICAL) — complete in code

- **Goal:** reports show the real difference; no deploy alters posted entries.
- **Problems fixed:**
  - `GET /api/stats/import-cycle-balance` no longer writes `equity_adjustment_*`; it reports the difference and explains it.
  - `POST /api/admin/recalculate-equity-adjustment(-all)` report only.
  - `POST /api/admin/initialize-accounting-balances` reports the opening a balancing entry would need; it no longer rewrites the Profit account's opening balance, creates `CAP-001` or emits SQL to do so.
  - Retired boot steps: GUAR-CASH debit/credit swap (007), duplicate-account merge with hard delete (009), STOCK_ADJUSTMENT merge, BONUS_EXPENSE type rewrite, credit-note variance re-routing, TR-IN TRANSFER-CLEARING swap. The insurance-account cleanup now skips accounts that have postings.
- **Accounting risk removed:** silent hiding of multi-million differences; deploy-time reclassification, re-pointing, inversion and deletion of posted history.
- **Database impact:** none (no schema change). Existing `system_settings.equity_adjustment_*` rows are left as historical evidence and are not read by any report.
- **Production impact:** the dashboard Import Cycle figure will show the real unreconciled difference per company (≈ −26.8M for company 12, −6.0M for company 1, +1.5M for company 13 at audit time). This is the truth, not a regression.
- **Note:** production runs with `RUN_STARTUP_MIGRATIONS=false` (confirmed in the 2026-10-06 boot log), so the ordered startup-schema pass and `runServerStartupMigrations` repairs do not run there at all; even when they run, the startup client has no tenant scope and the ledger tables use FORCE ROW LEVEL SECURITY. The rewriters were latent in production and active in every other environment (CI, fresh installs, any boot with migrations enabled).
- **Acceptance:** no code path writes `equity_adjustment_*` or rewrites openings to force balance (verified by grep); no unguarded boot step updates/deletes `voucher_entries` or `ledger_accounts`; tests pin the no-write behaviour.

### Wave 2 — Voucher edit integrity (CRITICAL) — complete in code

- **Goal:** editing a voucher can never silently unbalance it, drop sub-ledger links, wipe its lines or post to nothing.
- **Problems fixed** (shared rules in `server/services/accounting/voucherEntryReplacement.ts`):
  - `PATCH /api/vouchers/:id` replaces lines only when `entries` are sent (header-only edits used to delete every line); validates targets and exact balance; accepts the Daybook `{accountType, accountId}` shape (which used to insert lines with no account); refuses to activate an optional voucher whose lines do not balance.
  - `PUT /api/vouchers/:id/with-entries` runs header, lines and daybook mirror in one transaction (it used autocommit writes with a best-effort restore), validates exactly instead of a float sum with 0.01 tolerance, and rejects lines with no or several accounts.
  - Both routes re-link `customerId` on lines that post to a customer's own ledger account (edits used to remove those lines from the customer sub-ledger).
  - `POST`/`PATCH /api/voucher-entries` write in a transaction and roll back if the voucher would be left invalid (no client calls them; they accepted raw bodies).
  - `POST /api/voucher-entries/transfer-account` refuses soft-deleted destinations, migrated/programme vouchers and non-ledger lines; clears a customer link that would point at an unrelated account; writes an audit record of every moved line.
- **Database impact:** none.
- **Production impact:** malformed edit requests now get 400 instead of corrupting a voucher. Live UI edit flows send header-only PATCHes or balanced with-entries payloads and are unaffected (108 existing voucher/edit test files pass).
- **Acceptance:** 9 new integration tests fail on the old code and pass on the new.
- **Still open (Wave 7):** edits still replace lines in place (history kept in `audit_log`, not as reversal entries); the inter-company counterpart re-scale after a with-entries edit still runs outside the transaction.

### Wave 3 — Accounting integrity diagnostic and trial balance (HIGH) — complete in code

- **Goal:** one authoritative, read-only view of whether a company's ledger is right, with differences shown and explained, never plugged.
- **Added:**
  - `GET /api/accounting/trial-balance?asOf=YYYY-MM-DD` (Admin/Owner): every posted line of live, non-optional vouchers attributed to exactly one row (ledger > bank > fixed asset > supplier > employee > factory supplier > customer, so customer lines on their own account count once), plus opening balances from master records; opening / period / closing Dr and Cr; `unexplainedDifference` = closing Dr − Cr, decomposed into opening balances, single-sided stock vouchers and other unbalanced vouchers. Lines with no account and lines on missing accounts get their own rows.
  - `GET /api/accounting/integrity` (Admin/Owner): unbalanced vouchers (defects vs by-design stock vouchers), lines with no or several accounts, lines on missing/other-company, deleted or inactive accounts, foreign-currency lines without native amounts, opening-balance imbalance and assumed sides, customer opening vs its account, employee cached-balance drift, non-canonical account types, missing equity account, and the legacy stored plug.
- **Database impact:** none (read-only).
- **Production expectation (computed read-only on 2026-10-06):** trial-balance differences are dominated by opening balances — company 1 −8,574,558.93; company 13 +6,031,800.93; company 10 +528,953.59; company 8 +60,856.17; company 17 −42,822.50; company 12 +22,450.19 — plus a few thousand from single-sided stock vouchers. Company 12's −26.8M import-cycle plug is not a GL imbalance: it is the gap between the GL and factory operational figures (factory revenue and COGS are not posted to the GL).
- **Acceptance:** integration tests seed a ledger with a known opening imbalance, a one-sided stock voucher and an account-less line, and assert the exact difference and its decomposition; non-admin roles get 403.

### Wave 4 — Database ledger guards (CRITICAL) — complete in code

- **Goal:** no code path can post to a missing, deleted or other-company account, or delete an account that carries history.
- **Added** (`server/services/accounting/ledgerIntegrityGuard.ts`, installed on every boot by `ensureLedgerIntegrityGuard`, because production skips the ordered migration pass):
  - foreign keys `voucher_entries.ledger_account_id / bank_account_id / fixed_asset_id` → their accounts, `ON DELETE RESTRICT`, `NOT VALID` (existing orphans stay visible to the diagnostic; new ones are impossible; an account with lines can no longer be hard-deleted);
  - CHECK constraints (NOT VALID): amounts non-negative; at most one side per line;
  - trigger `voucher_entries_target_guard`: every account a line names belongs to the line's company (a supplier may belong to the parent or a subsidiary — the group's shared-supplier PO pattern seen in production, in both directions) and is not deleted; checked only when a line's accounts are set or changed, so legacy rows stay editable;
  - trigger `ledger_accounts_delete_guard`: an account whose balance (opening plus posted lines of live, non-optional vouchers) is not zero cannot be soft-deleted; an account emptied by a journal (account migration) can still be retired, its history staying on its vouchers;
  - `app.ledger_integrity_bypass` (transaction-local) for a reviewed repair only;
  - versioned install (`LEDGER_INTEGRITY_GUARD_VERSION`): once installed, later boots run no DDL and take no locks on the ledger tables.
- **Root-cause fix:** own-account freight and other charges on offload posted their expense line to no account (the 13 production lines, ≈39k): `offloadCosting.ts` resolved the expense account only on the supplier path.
- **Callers adjusted:** the factory `getOrCreateLedgerAccount` restores a soft-deleted system account instead of posting to it; insurance member deletion soft-deletes the member's account only when it has no postings and no opening balance; account migration (execute, undo, round-trip) moves an account to its new company before writing lines that reference it there (same transaction, same result).
- **Verified against production (read-only, last 90 days, 13,681 lines):** no live posting would have been refused; the only hits were three lines on already-deleted vouchers.
- **Production impact:** writes that would corrupt the ledger now fail with a named error (e.g. `LEDGER_ACCOUNT_COMPANY_MISMATCH`) instead of succeeding. Production data was checked first: no live flow posts to deleted accounts; cross-company supplier lines are the parent-supplier pattern, which is allowed; the 9 legacy cross-company ledger lines (Jan–Jun 2026) are not repeated.
- **Database impact:** DDL only; no existing row changes. The diagnostic's `database_guards_installed` check confirms installation after deploy.

### Wave 5 — Chart of accounts registry and fiscal close (HIGH) — complete in code

- **Goal:** one controlled definition of system accounts, every company provisioned, and a fiscal close that closes the whole income statement.
- **Added:** `server/services/accounting/systemAccounts.ts` (registry of 14 system accounts with code, name and type; `ensureSystemAccounts` idempotent with ON CONFLICT DO NOTHING; existing accounts never changed — type differences, deletions and name-only matches are reported); `accountClassification.ts` (canonical types, income-statement types, case normalization).
- **Provisioning:** `RETAINED_EARNINGS` and `OPENING_BALANCE_EQUITY` (Equity) are created for every company at boot under the process-owned maintenance scope (verified: two consecutive boots, one account each per company, nothing duplicated), and on demand by `POST /api/accounting/system-accounts/ensure` with `{ "confirm": true }`; `GET /api/accounting/system-accounts` diagnoses. No AR/AP control accounts are created: nothing in the current posting model would post to them (see Wave 8).
- **Fixed:** fiscal close now closes Income, Indirect Income, Expense, Direct Expense and Indirect Expense (it closed only Income and Expense, leaving most production expense accounts open across years); factory system accounts are created with registry types (the default was the unrecognised `EXPENSE`); the `'^\d+$'`-in-template-literal regex bug that restarted numeric account codes at "1" (4 sites).
- **Explicit, audited repair:** `GET/POST /api/accounting/account-types/normalization|normalize` rewrites only the spelling of mis-cased types ('EXPENSE' → 'Expense'); genuinely wrong types (e.g. `FACTORY_CHARGES_PAYABLE` typed Direct Expense, `INVENTORY` in company 17 used as "Credit Note - Customer Return") are reported for a reviewed decision, never guessed.

### Wave 7 — Atomic posting for remaining writers (HIGH) — partially complete

- **Done:** PO creation (`createPurchaseOrder`) writes the PO, its voucher(s), lines and voucher link in one transaction with exact decimals (float totals could leave a PO voucher a cent out of balance); payroll `pay-worker` and `bulk-pay-workers` post voucher and lines in one transaction with exact cents (bulk vouchers could miss balance by a cent) and refuse workers of another company; ERP manual container create commits container, purchase voucher and both lines together; factory supplier FX transfer create/delete are transactional and an allocation failure rolls the transfer back instead of being swallowed.
- **Not done (remaining risk):** PO line-item / charge edits outside one transaction; factory container create; factory payroll "mark PAID" posts no cash voucher and one payroll generator posts no accrual; advance delete leaves repayment vouchers; inter-company counterpart re-scaling outside the edit transaction; a database balance constraint (blocked until every writer posts in one transaction — ~70 writer files).

### Wave 6 — Factory foreign-currency base amounts (HIGH) — complete in code; legacy repair not yet applied

- **Problem:**
  - Factory freight, other-charge, charge, payment and manual-purchase vouchers in EUR and AUD stored the native amount in `debit_amount`/`credit_amount`, which are the USD base columns, and left the `transaction_*` fields empty. Company 12 has 462 such lines, and they were still being written.
  - Own-account legs of the same vouchers stored USD.
  - The expense, payable and cash accounts and the trial balance therefore summed EUR/AUD as USD.
- **Reader inventory:** two read-only sweeps covered every reader of these lines.
  - Supplier balances come from the container, charge and payment tables. Their voucher-payment readers read only debit lines and exclude `FACTORY-PAY-*`, so normalizing the factory writers cannot double-convert a supplier balance.
  - The general readers (net profit, cash and bank summaries, statements, reports) already use `base_*`/`transaction_*` when present.
  - Eight factory-supplier readers converted `debit_amount` from the voucher's currency on every row: single balance, with-balances, statement, net position, raw-material reconciliation, voucher sidebar, broker statement and broker visual statement. They therefore converted already-normalized rows a second time, for example CFA payments, which the trigger stores in USD.
- **Changed — readers:** `server/services/factory/voucherEntryCurrency.ts` gives an entry's native amount (`transaction_*` when normalized, else `debit_amount` in the voucher's currency) and its stored USD base (normalized entries, and legacy USD entries).
  - The eight readers use the stored base for normalized entries and keep their existing conversion for legacy entries only.
  - No legacy figure changes. Normalized CFA payments to factory suppliers are no longer converted twice.
- **Changed — writers:** every leg is now normalized, with the USD base = native × the factory USD-per-unit rate (`BASE_PER_TRANSACTION`).
  - Writers covered: offload freight, other charges and additional charges; post-offload charges and their backfill; supplier payments (`FACTORY-PAY`); manual raw-material purchases; reverse-offload freight restore.
  - A non-USD amount whose rate was never set keeps the legacy shape, so the diagnostic still reports it instead of normalizing it at a guessed 1.
- **Fixed — rounding:**
  - `normFactoryEntry` stored the inverse rate rounded to 10 places as `TRANSACTION_PER_BASE`. That reproduced the base only for small amounts, so the production currency trigger refused larger lines (AUD 250,000 at 0.6543219 gives 163,580.475000 against .475003).
  - It now stores the factory rate itself, and both factory normalizers compute the base from the stored rate.
- **Fixed — third-currency freight:** container create and update posted freight in a third currency (neither USD nor the container's) at rate 1. They now use the freight's own confirmed rate and refuse the write when it is missing.
- **Added — legacy repair:** `GET /api/accounting/factory-fx-repair` (plan, read-only) and `POST /api/accounting/factory-fx-repair/apply` (`{"confirm": true}`, Admin/Owner, audited).
  - Each line is classified from its own voucher. An amount equal to the voucher total is native. An amount equal to the total at the voucher's stored rate is already USD.
  - Lines are reported and left alone when they match neither or both, when the rate was never set, or when the voucher is in a closed period. Every other line of such a voucher is also left alone, so no voucher is half-converted.
  - Lines are converted at the voucher's own stored rate, never a current one. The plan is re-derived under row locks inside the apply transaction, and only lines still in the legacy shape are changed.
  - The plan reports the USD change by account, supplier and bank, which is the before/after ledger diff.
- **Tests:**
  - `factory-fx-entry-readers`: helpers, and a normalized CFA payment against a legacy EUR payment on the supplier balance.
  - `factory-fx-legacy-repair`: the production currency trigger from `migrations/20260720_005` is installed for the test, because neither the test database nor CI installs it. It accepts the normalized writer output and the repair UPDATE. The test covers classification, skips, idempotence and the closed period.
  - `factory-container-fx-voucher-normalization` is updated for the stored-rate convention.
- **Production:**
  - The writers take effect on deploy.
  - The legacy lines change only when an Owner/Admin applies the repair, which must happen after reviewing `GET /api/accounting/factory-fx-repair`. The plan's `usdChangeByTarget` is the expected movement of the expense, payable and cash balances.
  - After applying, `foreign_currency_lines_without_native_amount` falls to the lines the plan reported as skipped.
  - The repair was not run in this session: the production database is not reachable from it.

### Wave 8 — Inventory, COGS and factory revenue in the ledger (CRITICAL, architectural) — in progress (8.0 complete)

- **Problem:** the GL is a cash and payables book.
  - Purchases are expensed, and sales post no COGS.
  - Inventory lives only in the sub-ledgers.
  - Stock adjustments post one side.
  - Factory revenue and receivables never reach the GL; finalize and dispatch invoicing write `customer_balances` only.
  - Opening balances sit on master records.
- **Decisions (owner, 2026-10-07):**
  - **Perpetual inventory.**
  - **The factory's existing costing is the book cost:**
    - raw material at landed cost (`dCostPerKgUsd`)
    - mixes at the supplier moving-average rate
    - bales at their recorded `total_cost`
    - differences go to a production variance account
  - **Cut-over on 2026-11-01**, with one reviewable opening inventory journal per company that an Owner applies.
- **Findings that shape the build** (read-only maps of every posting path):
  - ERP purchases post at PO import while stock arrives at container offload, so a goods-in-transit step is needed.
  - Offload charges are in the stock sub-ledger value but expensed in the GL.
  - POS posts its GL lines before relieving stock, and `adjustInventory`'s relieved value is discarded.
  - Several paths assume a sale voucher has one debit and one credit: `rebuildSaleAccounting`, `purchaseOrderItemsUpdate`, and the `balanced` expectation for Sales/Purchase.
  - Factory bale cost on the main stock-entry path is the catalogue `productionPrice` × kg, while the production-value report treats `productionPrice` as per bale. Pressing finalize reads the native-currency raw cost.
  - Customer-balance formulas exclude `INV-%`/`CHARGE-%` vouchers inconsistently, so receivable vouchers must be designed with them.
  - P&L and net position add a computed stock-in-hand figure that would double count a GL inventory balance.
- **Phases:** the company switch cannot be turned on until 8.5 (`PERPETUAL_INVENTORY_POSTING_READY`). Turning it on with some paths unconverted would leave half-periodic books.
  - **8.0 Foundation (complete):**
    - Registry accounts: `GOODS_IN_TRANSIT`, `FACTORY_RAW_MATERIAL_STOCK`, `FACTORY_WIP`, `FACTORY_FINISHED_GOODS`, `PRODUCTION_VARIANCE`.
    - The `gl_inventory_cutovers` table, declared in `shared/schema` and created at boot with the same constraint names.
    - The gate `isPerpetualInventoryActive(executor, company, date)`: true only on or after the company's applied cut-over date.
    - `GET /api/accounting/perpetual-inventory/opening-plan`:
      - Dr Inventory: ERP stock as of the eve, via `computeStockInHand`.
      - Dr Raw Material: remaining kg × landed USD cost.
      - Dr WIP: open mix kg × mix cost, plus bales awaiting pressing.
      - Dr Finished Goods: bales held, at recorded cost.
      - Cr Opening Balance Equity: the total.
      - Rows with no cost are listed, never valued. Bales marked sold on unfinalized orders are reported.
    - `POST /api/accounting/perpetual-inventory/apply` (Owner, `confirm`) posts the journal and records the cut-over in one locked transaction, once per company. It is refused while posting is not ready, for a future date, and a second time.
    - Test: `perpetual-inventory-cutover`.
  - **8.1 ERP sales:** COGS = the exact value `adjustInventory` relieves (POS create/edit/import/credit sales/delete/optional toggle); fix the one-debit/one-credit assumptions.
  - **8.2 ERP purchases:**
    - PO import posts Dr Goods in Transit.
    - Offload posts Dr Inventory for the sub-ledger value received, against Goods in Transit and the charge payables.
    - PO edits follow.
  - **8.3 Stock adjustments and production/consumption:** posted on both sides against `STOCK_ADJUSTMENT`, with the voucher expectations reclassified.
  - **8.4 Factory:**
    - Offload: Dr Raw Material against import cost and capitalised charges.
    - Mix: Dr WIP / Cr Raw Material.
    - Bale entry: Dr Finished Goods / Cr WIP, with the variance.
    - Finalize/dispatch: Dr customer / Cr Sales and Dr COGS / Cr Finished Goods.
    - Post-finalize edits, unfinalize, and the customer-balance formulas.
  - **8.5 Reports and the switch:** P&L and net position read the GL for a switched-on company; the deferred debit = credit constraint; `PERPETUAL_INVENTORY_POSTING_READY = true`.
- **Not in scope:** moving master-record opening balances into journals needs its own reviewed migration. Every reader adds `opening_balance` to its entries, so posting them as journals without zeroing the master records would double count.

