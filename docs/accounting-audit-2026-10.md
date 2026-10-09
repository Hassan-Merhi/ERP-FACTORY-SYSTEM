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
- **Not done (remaining risk):** none in code — PO line-item / charge edits, factory container create, factory payroll "mark PAID", the payroll generator's accrual and advance delete are closed in "Wave 7 leftovers (2026-10-09)" below; inter-company counterpart re-scaling (converted in 8.5) and the database balance constraint (installed in 8.5 for perpetual-inventory companies from their cut-over) were done earlier. What stays open is listed under that entry's "Remaining".

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

### Wave 8 — Inventory, COGS and factory revenue in the ledger (CRITICAL, architectural) — built (8.0–8.5 complete; the switch is off until production is checked)

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
      - Each line posts its value less what the ledger already holds on the account as of the eve: opening balances and active postings. Credit and debit notes have always posted to Inventory, so a full-value line would count them twice. A line whose ledger balance exceeds its value credits the account. Added in 8.3; no cut-over had been applied.
    - `POST /api/accounting/perpetual-inventory/apply` (Owner, `confirm`) posts the journal and records the cut-over in one locked transaction, once per company. It is refused while posting is not ready, for a future date, and a second time.
    - Test: `perpetual-inventory-cutover`.
  - **8.1 ERP sales (complete):**
    - Each sale posts a linked journal, `COGS-{saleVoucherId}`: Dr COGS / Cr Inventory for the exact value the stock sub-ledger relieved. That value is the drop in `inventory.total_value` that `adjustInventory` reports, so ledger inventory moves with the sub-ledger.
    - Keeping COGS out of the sale voucher leaves every one-debit/one-credit sale reader valid.
    - Wired paths:
      - POS create
      - POS edit: replaces the journal
      - POS import and credit-sales import
      - delete and bulk delete: remove the journal
      - optional toggle: optional removes it; active re-posts it at the value taken out again
    - Gated per company and date. Supplier-partner companies are skipped, because their stock is in `sp_stock`; the opening plan does not capitalise their ERP stock either.
    - Remaining difference, to be checked by the 8.5 reconciliation: the sale delete path re-receives stock at `salesItems.costPrice` rather than by exact value.
    - Test: `perpetual-inventory-sale-cogs`.
  - **8.2 ERP purchases (complete):**
    - The PO voucher and the offload charge vouchers keep posting as before. Two linked journals carry their cost to the balance sheet:
      - `GIT-PO-{purchaseOrderId}`, dated with the PO voucher: Dr Goods in Transit / Cr Purchases for what the PO voucher debited to Purchases.
      - `STOCK-IN-{containerId}`, dated with the offload: Dr Inventory for the value the stock sub-ledger received (`container_offload_items` of active offloads). It credits Goods in Transit for the container's POs in transit (a PO with a GIT journal, or one dated before the cut-over, which the opening journal carries) and each account an offload charge voucher debited. The difference goes to Purchases, so a PO that disagrees with its landed value stays visible there.
    - The opening plan has a Goods in Transit line for POs dated before the cut-over whose container was not offloaded before it.
    - Wired paths:
      - PO create and delete
      - PO edits: items, charges, purchase voucher edit, container voucher sync, standalone PO repair
      - PO voucher delete, bulk delete, restore and optional toggle
      - offload create/replace, edit, reverse and optional toggle
      - offload charge voucher edits (re-pricing)
      - container delete
    - Remaining differences, to be checked by the 8.5 reconciliation:
      - Landed charges with no charge voucher (transfer charges, container charges) go to Purchases through the difference line.
      - Older code: container delete hard-deletes the PO voucher without its posting identity, so the database refuses the delete (`accounting_posting_requests` restricts it), and the steps before that are not in one transaction. The linked journals are removed last, so a refused delete leaves them in place.
    - Test: `perpetual-inventory-stock-receipts`.
  - **8.3 Stock adjustments and production/consumption (complete):**
    - A stock adjustment voucher (Production, Consumption, Mixed, Stock Adjustment) keeps its `STOCK_ADJUSTMENT` lines. Once the cut-over applies, it also carries one line on the inventory control account for the net of its other lines, so the voucher balances: production Dr Inventory, consumption Cr Inventory.
    - The line is derived from the voucher's current lines and marked by its narration. An inventory line entered by hand is left alone and counted with the others. Optional, deleted and pre-cut-over vouchers and supplier-partner companies carry none.
    - Wired paths:
      - adjustment create and edit
      - adjustment date change
      - generic line replacement and single-line writes
      - header edit and optional toggle
      - restore
    - Voucher expectations reclassified: "single-sided" (Stock Adjustment, Production, Consumption) now accepts one side posted (periodic) or both sides posted and equal (perpetual), in the convergence reconciler and the phase 3 audit.
    - Credit and debit notes already post their inventory line at cost, with a variance line, before and after the cut-over. The 8.5 reconciliation checks them with the rest.
    - Test: `perpetual-inventory-stock-adjustments`.
  - **8.4 Factory (complete).** Owner decisions, 2026-10-07:
    - the receivable posts to each customer's own ledger;
    - the stock chain posts one derived journal a day;
    - invoices in a currency other than USD post nothing and are listed.
    - **Factory invoices.** A finalized order, including a dispatch-batch invoice, posts `INV-GL-{company}-{order}`:
      - Dr customer ledger / Cr Factory Bale Sales Income, for the grand total less the charges that have their own `CHARGE-` voucher.
      - Dr COGS / Cr Factory Finished Goods, for the recorded cost of its bales.
      - Voucher numbers are unique across companies while invoice sequences are per company, hence the company and order in the number; the invoice number is in the description.
      - The journal is rebuilt from the order on every path that changes it: finalize, dispatch invoicing, un-finalize, and every totals recalculation (`recalculateOrderTotals`, which covers repricing, charges, swaps, removals, exchanges, recoveries and charge-journal syncs). It is also rebuilt when a charge voucher is deleted, restored or made optional.
      - A customer with no ledger account gets `CUST-{id}`, as the charge vouchers already do.
    - **Customer readers.** The five factory customer readers that rebuild the invoice from `grand_total` now skip `INV-%` vouchers, as the factory statements already did: the customer ledger builder, the paginated statement, `/api/accounts/all`, the ledger balance, and the statement opening balance. The ledger readers (trial balance, net position, the generic customer balance) now include the invoice they were missing.
    - **Factory POS.** A factory POS sale posts `FPOS-COGS-{sale}`: Dr COGS / Cr Finished Goods for the cost of the bales it marks sold. Edits replace it and voids remove it. A sale does not record which bales it took, so an edit's reverted bales can differ; the difference goes to the daily variance.
    - **Daily factory stock journal.** `GL-FACTORY-STOCK-{company}-{date}` is posted every evening at 23:45 UTC by the scheduler, and on demand through `POST /api/accounting/perpetual-inventory/factory-stock-journal` (Admin/Owner).
      - It moves Raw Material, WIP and Finished Goods to the value the factory costing holds now, the same valuation the opening journal uses.
      - It credits the raw material received since the previous journal (`factory_container_receipts`, USD) to the expense accounts the container's `FACTORY-` vouchers debited, in proportion, or to Factory Import Cost when there are none.
      - The rest goes to Production Variance: mixing and pressing differences, write-offs, waste, removals, revaluations.
      - It is posted for today only, replaced when it runs again the same day, and never recomputed for a past day.
    - **Valuation fixes,** shared by the opening plan and the daily journal (`factoryValuation.ts`):
      - Deleted raw-stock rows are left out.
      - Sold bales on orders not yet invoiced stay in finished goods until their invoice posts their cost.
      - ERP stock items that mirror factory bales (unit BALE, coded as a bale product) are left out of the opening Inventory line; the factory values those bales.
    - **Unposted invoices.** `GET /api/accounting/perpetual-inventory/unposted-factory-invoices` lists finalized invoices on or after the cut-over with no journal; today that is only non-USD dispatch invoices. The 8.5 switch must stay off while any are listed.
    - **Remaining differences,** for the 8.5 reconciliation:
      - Manual raw-material ADD adjustments already debit Raw Material, but the costing does not value them; the daily journal reverses them into variance.
      - Opening-balance raw stock carries no expense, so its value reaches the ledger through variance.
      - Sold bales keep the cost they were invoiced at when a cost cascade later revalues them.
      - The ERP bale mirror is never reduced on a factory sale.
    - Test: `perpetual-inventory-factory`.
  - **8.5 Reports, reconciliation and the balance guard (complete; the switch stays off).** Owner decisions, 2026-10-07: convert the remaining voucher writers to one transaction each, then install the balance constraint; keep `PERPETUAL_INVENTORY_POSTING_READY = false` until production has been checked.
    - **Reports read the ledger's stock** once a company's cut-over covers the report date (`reportBasis.ts`). A report dated before the cut-over keeps the computed figures. Reports changed:
      - `/api/stats/net-profit` (and Group Net Position, which replays it)
      - `calculateNetPositionAsOf` (monthly Excel, WhatsApp, the net-position scheduler)
      - `/api/stats/net-position-excel`
      - `/api/factory/net-position`
      - the net-profit Excel
    - **What each report now does after the cut-over:**
      - The net-position classifier counts Inventory, Goods in Transit and the three factory stock accounts as assets (`ledgerStockAccounts`).
      - The computed stock in hand and containers on the way are not added.
      - The factory net position replaces its computed bale, raw-material and work-in-progress values with the ledger accounts. The selling-price view keeps its bale value in place of finished goods at cost. Pending, verified and loading orders are left out of the total at cost, since their bales are in finished goods.
      - The net-profit Excel drops its periodic opening and closing stock terms, because cost of sales is in the ledger. A period spanning the cut-over should be run as two periods split at the cut-over.
    - **Account type.** `FACTORY_BALE_SALES_INCOME` joins the registry as Income.
      - It had been created as "Revenue", which every P&L reader ignored while net position counted its credit balance as a liability.
      - New accounts are created as Income, and net position treats Revenue-typed accounts as income.
      - Existing Revenue-typed rows are reported as `type_differs` by the integrity diagnostic, for an Owner to correct; they are not changed automatically.
    - **Reconciliation.** `GET /api/accounting/perpetual-inventory/reconciliation` (read-only) compares the ledger with the sub-ledgers, account by account:
      - Inventory with ERP stock in hand, without the bale mirror
      - Goods in Transit with the purchase cost of POs not yet offloaded
      - the factory accounts with the factory costing
      - It also lists unposted factory invoices.
    - **Voucher balance guard** (`voucherBalanceGuard.ts`, installed at boot): a deferred constraint trigger.
      - At commit it refuses an active voucher dated on or after its company's cut-over whose debits and credits differ.
      - It leaves alone earlier vouchers, companies without a cut-over and supplier-partner companies.
      - Re-activating, re-dating or moving a voucher is checked too.
      - A reviewed repair can bypass it with `app.ledger_integrity_bypass`.
      - Before installing it, the 39 writers that wrote a voucher's lines in separate autocommit statements were converted to one transaction each: payroll, factory containers, PO import, SP migration tools, admin repairs, and intercompany counterpart rescaling.
    - **Writers that can still leave a voucher one-sided by their own logic.** These were converted as they are. After a company's cut-over the guard refuses them (the request fails and nothing is written) instead of letting them post one-sided:
      - a factory container freight voucher paid by its own account with no account set, or by the supplier with no supplier set;
      - a factory bulk withdrawal that skips an employee it cannot find but credits cash for the full total;
      - the payroll run migration for a run with no payment account;
      - the admin PO-credit fixes for a PO with no supplier, or one missing only one leg.
    - **Applying the cut-over** is now refused while any voucher is already dated on or after the cut-over date. Such a document would carry none of its perpetual-inventory postings, so the cut-over is applied before the first document of its date.
    - **Before turning the switch on:**
      - run the opening plan and the reconciliation against production
      - correct the Revenue-typed `FACTORY_BALE_SALES_INCOME` rows
      - review the remaining differences listed under 8.1–8.4
    - Tests: `perpetual-inventory-reports`, `voucher-balance-guard`.
- **Not in scope:** moving master-record opening balances into journals needs its own reviewed migration. Every reader adds `opening_balance` to its entries, so posting them as journals without zeroing the master records would double count.


### Wave 9 — Ledger safety (CRITICAL) — complete in code, except the items listed as open

Fixes CRITICAL items 1–4 from the re-audit (section 7). Item 5 (inventory paths with no ledger counterpart) belongs to wave 11.

- **Balance guard v2** (`voucherBalanceGuard.ts`): every active voucher *created* after the guard's install must balance at commit, in every company. The install time is the `voucher_balance_guard_since` system setting. Vouchers created before it are history and are never checked, so legacy rows stay editable and the integrity diagnostic keeps reporting them. Stock adjustment types are still checked only under perpetual inventory in a non-supplier-partner company. Lines all in one transaction currency are compared in that currency.
- **FX revaluation:** saving an exchange rate no longer posts an `FX-REVAL-` journal. Existing ones are not touched; the integrity diagnostic lists them (`automatic_fx_revaluation_journals`, warn) for review.
- **Unbalanced-activation paths closed:**
  - the live voucher-line PATCH (`voucherEntryCurrencyEditRoutes.ts`, which had shadowed wave 2's validated route) now runs in one transaction: it syncs the stock adjustment, validates the stored lines and writes its audit inside the transaction;
  - `PATCH /api/vouchers/:id/optional` and `POST /api/vouchers/:id/finalize` validate the lines before activating; finalize now needs Admin or Owner and is audited;
  - `PUT /with-entries` refuses changing a balanced voucher to a type exempt from balancing.
- **Balance sheet** (`/api/reports/balance-sheet`) is rebuilt on the trial balance: the optional and deleted filters, opening sides, every account type, parties by sign and a current-earnings line. Its remaining difference equals the trial balance's unexplained difference.
- **Destructive admin routes:**
  - the three company reset routes are Owner-only, act only on the session's company, run in one transaction and are audited. The audit row records the vouchers removed and the previous opening balances;
  - the hard reset removes posting identities with their vouchers and refuses a set that contains a fiscal-period closing voucher;
  - undo restores only the vouchers its own reset deleted (matched by the recorded `resetAt`), once. Resets run before this change have no audit row and cannot be undone;
  - voucher restore and permanent delete need Admin, Owner or Developer, run in one transaction and are audited with the lines. Permanent delete refuses a fiscal-period closing voucher instead of deleting the closure;
  - deleting one side of an inter-company transfer soft-deletes and audits the other company's voucher, keeping its lines, on every path: single delete (Payment/Receipt, Journal and other types) and bulk delete.
- **Still open:**
  - company delete still removes `audit_log`;
  - permanent delete of an orphaned POS sale is still autocommit and unaudited;
  - permanent delete of an engine-posted voucher fails on its posting identity (it now rolls back cleanly);
  - the reset page still offers any company and shows to Admins; the server refuses both.
- Tests: `voucher-balance-guard`, `balance-sheet-from-trial-balance`, `wave9-ledger-safety-routes`, `wave9-admin-history-safety`.

### Wave 10 — One balance engine (HIGH) — parts 1 and 2 complete in code

Owner decisions (binding): a customer's opening is owned by the customer record and counted once; a voucher counts from `COALESCE(effective_date, voucher_date)`; balances come from the ledger only, and amounts that never reached it are separate, labelled "not yet in the ledger" memo lines; each voucher line belongs to its voucher's company.

- **Part 1:** one account classification (`accountClassification.ts`); the trial balance's row source became the party engine (`balances/ledgerBalanceEngine.ts`, `getPartyBalances`).
- **One line, one party (part 2).** The two customer rule sets are reconciled on the double-entry rule, defined once in `balances/partyLineRules.ts` and used by the engine's attribution and by every statement's line filter. A line goes to exactly one row by priority ledger > bank > fixed asset > supplier > employee > factory supplier > customer. A customer owns the lines on its linked ledger (the lowest customer id owns a ledger linked to several) and its customer-tagged lines that name no other target. The part-1 reader rule, where an unlinked customer owned every tagged line and a customer owned its tagged bank lines, counted those lines twice across the trial balance and is retired. `storage/accounting/customer-ledger-balance.ts`, the factory composite `buildFactoryCustomerLedgerEntries` and `factoryCustomerLedgerStatement.ts` are deleted. On the engine now:
  - `/api/customers/stats`, the voucher sidebar, POS customers, `getCustomerBalance` and the overdue reminder;
  - customer transactions, plain and paginated, and their pre-period figure (the engine's carried-forward movement);
  - the account pre-period balance and the account statement PDF/Excel for a customer or a customer-owned ledger;
  - `/api/accounts/all`, `/api/accounts/ledger/:id/balance` and ledger transactions for a customer-owned ledger, for every company type.
- **Memo lines** (`balances/unpostedMemo.ts`, `getPartyBalances({ memo: true })` → `memoLines`, `memoTotal`; never part of `closing`):
  - customers: FINALIZED factory invoices with no live `INV-GL-{company}-{order}` journal, at grand total less the charges that have their own live CHARGE- voucher; factory POS credit sales and deposits; other `customer_balances` rows with no ledger counterpart. Excluded: INVOICE/SALE cache rows (the order is the source), `voucher` rows with a live voucher, CONTAINER_SALE rows;
  - factory suppliers: container goods with no FACTORY-IMPORT journal, supplier-paid freight with no FACTORY-FREIGHT journal, and commission with no FACTORY-COMM journal. Amounts are converted at the container's confirmed rate; with no rate, `amount` is null and the line is listed but not totalled.
  - Customer transactions return them as `notInLedger.rows` (`notInLedger: true`), outside the rows, the pre-period figure and the totals. The Accounts page shows them in a separate section.
- **Factory customer pages:**
  - `GET /api/factory/customers` and the statement (page, Excel, PDF) keep `balance` / `currentBalance` / `runningBalance` as the combined figure the page always showed, now computed as engine closing + memo total and labelled `balanceBasis: "ledger+notInLedger"`;
  - they add `ledgerBalance`, `ledgerBalanceSide`, `notInLedgerTotal`, `ledgerRunningBalance` and per-row `notInLedger` flags;
  - statement ledger rows now include the CHARGE- and INV-GL journals; an INV-GL row is shown as its invoice;
  - `/api/accounts/all`, `/api/accounts/ledger/:id/balance` and the pre-period balance report the ledger figure alone, with `notInLedgerTotal` / `notInLedgerBefore` beside it. **Meaning change:** for a factory customer's ledger on the Accounts page, `balance` is now the ledger balance; it used to be the combined figure.
- **Net position** (`balances/netPositionParties.ts`). The live net position, the net-position Excel, `calculateNetPositionAsOf` and the factory net position take customers, ERP suppliers, factory suppliers and employees from the engine:
  - historical-base closing, effective-date basis, master opening with its side;
  - the ERP payroll from the employee subledger, no longer from `employees.current_balance`.
  - Customer-owned ledgers are left out of the ledger classification everywhere, so a customer is never counted twice. The ledger-account aggregates moved to the effective-date basis.
  - A separate `notInLedger` section (`{ label, total, lines }`) lists what is not in the ledger, and is never in What We Have / What We Owe: the memo lines above; the factory's unfinalized PENDING/VERIFIED/LOADING orders at selling price; the salary-advance and factory-worker-advance tables' excess over the ledger; and `employees.current_balance` over the ledger.
  - The factory net position no longer strips the "Factory Worker Advances" ledger account. The client no longer overrides supplier figures with the Suppliers-page formula.
  - Stock, OTW containers and rent stay as they were (documented valuation lines; perpetual gating unchanged).
  - The supplier-partner customer helper is removed: its clause could never admit a ledger, so supplier-partner companies still exclude customers. Golden Coast keeps its customer-like account exclusion.
- **New customers:** `customerService.create` and the POS customer create give the new CUST ledger a zero opening and no longer copy later opening edits onto it. The factory paths already created it at zero.
- **Bank-linked ledgers:** not a double count in the engine. A bank and its linked ledger are separate master rows, each opening is counted once, and a line naming both goes to the ledger. Other readers differ, so a linked bank is shown in different places:
  - `cashBankRevaluationService` drops a linked bank's own row;
  - `/api/accounts/ledger/:id/balance` merges it into the ledger;
  - net position read no bank accounts at all (closed in part 3 below).
- Tests: `wave10-engine-consolidation`, `wave10-net-position-engine`; updated `wave10-party-reader-rules`, `phase33d-employee-net-position`, `stats-net-position-excel-behavior`, `account-statement-*`, `perpetual-inventory-factory`, `report-endpoint-characterization` (pins regenerated).
- **Part 3: bank accounts in net position** (owner decision: Net Position includes bank accounts). Before, the dated net positions read no `bank_accounts` row or line and understated cash; only the live `/api/stats/net-profit` without a date showed banks, added by the cash/bank translation middleware.
  - `loadNetPositionParties({ banks: true })` adds the engine's `bank` rows as of the date: historical-base closing, effective-date basis, the bank's own opening with its side. They are presented like a Cash/Bank ledger account: category `Bank`, an asset when in debit, a liability (What We Owe) when overdrawn. Each line is labelled by the bank account's name and carries `bankAccountId`; `id` stays a ledger account id. Deleted and inactive banks are included like the other engine parties, and zero rows are skipped.
  - Engines: the live net position (with or without a date), the net-position Excel, `calculateNetPositionAsOf` (monthly Excel, schedulers, WhatsApp) and the factory net position. The factory adds the lines to its accounts and breakdowns, and reports `bankAssets` and `bankOverdrafts` beside `ledgerAssets`. Group net position re-runs the live pipeline per company, so it includes each bank once.
  - **Linked banks** (`bank_accounts.linked_ledger_id`): counted once. The bank line holds the bank's opening and the lines that name the bank and no ledger account. The ledger account's line holds the ledger's opening and every line naming the ledger, including a line that names both (engine priority). Every writer found posts a line to a bank *or* a ledger account, never both, so the "both" case exists only in a fixture. The two openings are separate master values: creating a bank never copies its opening onto the linked ledger. Readers outside net position still differ: `/api/accounts/ledger/:id/balance` and the payroll cash check merge a linked bank into its ledger (opening + all bank lines, so a line naming both would count twice there). `cashBankRevaluationService` in its default (`legacy`) attribution still drops a linked bank's row, opening and bank-only lines included, and puts every line naming a bank in that bank's aggregate.
  - **Live, no date:** the middleware now calls `getCashBankRevaluation(companyId, { attribution: "engine" })`. A bank's aggregate is then only the lines naming the bank and no ledger account, and a linked bank keeps its own row, so the translated rows split the lines exactly as the report's historical rows do. A resolved bank's historical row (matched by `bankAccountId`) is replaced by its translation, as a resolved ledger row is matched by `id`. It is never added a second time. Before, a line naming both a Cash ledger and a bank was translated twice, and a linked bank's opening was dropped. `currencyRevaluation.currentTranslatedBankAccountIds` lists the replaced banks. Differences that remain between live and dated views:
    - the live view values resolved cash and banks at the current rate;
    - a bank or ledger whose native currency is unresolved keeps its historical figure in both views;
    - the translation's opening uses `opening_balance_base_amount`, and the engine uses `opening_balance` (the stored company-base figure);
    - deleted banks are not translated, so their historical row stays.
  - Test: `wave10-net-position-banks`.

### Wave 11 — Inventory fidelity: factory bale cost basis (11.C) — complete in code

Owner decision 5 and the 2026-10-08 additions (binding): a bale's cost is USD material cost; existing stock is re-costed only through a reviewed, Owner-confirmed plan; the factory variance is split by source; the ERP bale mirror is quantity only; the factory POS records its bales; bales reserved for unfinalized orders are stock at cost.

- **Bale cost** (`services/factory/baleCostBasis.ts`):
  - a bale from a mix costs weight × the mix's USD `cost_per_kg`. Pressing finalize, stock entry with a mix and assign-bales use the mix's own cost, so the work in progress pressing relieves (used kg × mix cost) equals the finished goods it adds. Finalize no longer re-prices from `factory_raw_stock.cost_per_kg` (native);
  - a stock-entry bale with no mix costs its product's `production_price` **per bale** (`cost_per_kg` = price ÷ weight). It was price × kg. Garbage (HMD16) bales with no mix still cost nothing. Example: a 25 kg bale of a product priced 40 was costed 1,000.00; it is now 40.00 (1.6/kg);
  - imported bales: `weight × costPerKg` exactly (7dp, read as USD). Imported raw stock gets `cost_per_kg_usd` only for a USD container; any other currency stays unvalued until its rate is confirmed.
- **Mix sources at their USD rate** (mix create, top-up, edit): the supplier's persisted locked moving average when positive; otherwise the container's landed `cost_per_kg_usd` (or its `cost_per_kg` when the container's own currency is USD). The legacy receipt-weighted fallback, which could carry native costs and wrote the locked rate as a side effect, is no longer read by these routes. Never a native cost of another currency. **A source with no USD rate:** under perpetual inventory (cut-over applies to the document date) the mix, top-up, edit, pressing, stock entry from that mix and assign-bales are refused with 409 `FACTORY_SOURCE_NO_USD_RATE`. Before the cut-over the mix is recorded **unvalued**: `cost_per_kg` and `total_cost` 0 (sources keep the rates they have), its bales carry no cost, and the factory valuation lists both as unvalued. The reviewed re-cost values them once a rate exists. Mix cost columns are written at 7dp. Example: 100 kg from an AUD container (2.00 AUD/kg, landed 1.30 USD/kg, no supplier rate) was costed 1.30 only when the USD rate was set and 2.00 when it was not; it is now 1.30, or unvalued/refused.
- **Container cost recalculation** (`_helpers.ts` `recalculateContainerCosts`, from daybook edits): writes the container's USD cost per kg into the sources priced from that container alone (CONTAINER_DIRECT), not the native cost, and leaves supplier-priced sources at the supplier rate. Batch headers are written at 7dp (were 4dp / 2dp).
- **Cost cascade** (`rawStockCostCascade.ts`): once the company's cut-over applies (today), it re-costs only bales that are factory stock (pending pressing, in stock, reserved, not on a finalized/dispatched/sold order). SOLD, dispatched, loaded and written-off bales keep the cost their sale took. **Before the cut-over it keeps re-costing every bale of the batch, sold ones included** (decision: no ledger carries bale cost then, and order profit/history read the corrected landed cost).
- **Retired automatic re-costs:** `POST /api/factory/bales/backfill-costs` answers 410 (it re-costed every in-stock bale at the containers' native cost, unaudited). `POST /api/factory/raw-stock/recalculate-bale-costs` keeps its dry run (now the reviewed plan) and answers 410 to `confirm: true`.
- **Reviewed re-cost** (`services/factory/baleRecost.ts`, `GET /api/factory/bale-cost/recost-preview` Admin/Owner, `POST /api/factory/bale-cost/recost-apply` Owner with `{ confirm: true, planHash }`):
  - the plan lists per mix the old/new USD cost per kg and WIP change, per bale the old/new cost and basis, the unvalued rows, totals and a hash;
  - apply recomputes the plan in one transaction under an advisory lock and applies it only when the hash matches (409 `PLAN_CHANGED`); it is refused in a closed accounting period (today), recorded in `factory_bale_recost_runs` and the audit log (in the same transaction) with every old/new cost;
  - after the cut-over it posts `FACTORY-RECOST-{company}-{run}`: Dr/Cr Factory WIP and Finished Goods / Cr/Dr Factory Stock Revaluation. Before it, nothing is posted;
  - re-costed: in-stock and reserved bales not on a finalized/dispatched/sold order (SOLD bales never); mixes whose rate a re-costed bale uses and open mixes. A mix with a source with no USD rate, and its bales, are listed unvalued and left unchanged. Supplier-priced sources take the supplier's locked rate now (not the rate stored at mixing). Closed mixes referenced by bales get USD headers; only an open mix's remaining weight moves WIP.
- **Variance split** (`services/factory/factoryStockValueEvents.ts`, table `factory_stock_value_events`): writers tag factory stock value changes once the cut-over applies, and `GL-FACTORY-STOCK` posts each kind to its own account; Production Variance keeps only the remainder:
  - WASTE → Factory Waste and Write-off: bale removals (`stock-entry/remove`, `remove-by-product`), waste dispatch and its restore, at the bales' cost;
  - REVALUATION → Factory Stock Revaluation: container cost recalculation and cost cascades (the change of the whole factory valuation, measured before/after inside the transaction);
  - MATERIAL_PRICE → Factory Material Price Variance: a mix source priced at the supplier's rate against the container's landed cost (create, top-up, edit; the edit reverses the old sources' difference).
  - Each journal claims the unclaimed events (and its own day's on a re-run), so an event recorded after the evening run goes to the next day. The result reports `explained` per account.
  - Not tagged yet (remain in Production Variance): raw-material ADD/REMOVE adjustments, mix delete, consumption/carry-forward, PENDING_PRESSING bale costs.
- **ERP bale mirror:** pressing, stock entry and waste restore receive mirror bales at rate 0 (canonical movement unit cost 0); removals relieve at the mirror's average as before. Existing mirror values are not rewritten.
- **Factory POS** (`services/factory/factoryPosSaleBales.ts`, table `factory_pos_sale_bales`): a sale records the bales it took; a void or an edit puts back exactly those (those still SOLD) and forgets them; FPOS-COGS is the SUM of those bales' `total_cost`. A sale written before the table has no rows and keeps the old "most recent SOLD bale of the product at the location" heuristic.
- **Factory valuation** (`factoryValuation.ts`): open mixes with no cost are listed unvalued; an IN_STOCK bale on a finalized/dispatched/sold order is no longer finished goods (its invoice took it); `reservedForOrders` reports the bales of pending/verified/loading orders (already counted in finished goods).
- **Factory net position** (`netPositionInventory.ts`, `employeeNetPositionRoutes.ts`):
  - Stock In Hand is SUM(`factory_bales.total_cost`) (was SUM of the product `production_price`, one catalogue price per bale), and includes the bales reserved for unfinalized orders (RESERVED_FOR_ORDER / RESERVED_FOR_DISPATCH, and bales already SOLD on pending/verified/loading orders) before the cut-over. `reservedBales: { count, cost }` and `inventoryValueBasis` are reported. The selling view uses the catalogue selling price per bale of the same bales;
  - the pending/verified/loading order lines stay under `notInLedger` at selling price for information, flagged `informational: true` and **left out of the section total** (decision: listed, never totalled, so the same bales are not counted twice);
  - raw material never falls back to the native cost: a row is valued at its landed USD cost (or its own cost for a USD container) or not at all; manual adjustments count value only in USD; only persisted supplier locked rates are used (the read no longer back-fills one).
  - Example: a factory holding 10 bales costing 32.50 each, of a product priced 40 per bale, showed Stock In Hand 400.00; it now shows 325.00. A pending order's reserved bale costing 77.00 was not in Stock In Hand (its order's 500.00 selling value was in the not-in-ledger total); it is now in Stock In Hand at 77.00, and the 500.00 is listed but not totalled.
- **Selling-value reads kept, labelled:** the production value report (`valueBasis: "selling-value-catalogue-price-per-bale"`), order profit (`costBasis: "catalogue-production-price-per-bale"`) and the stock-entry daybook (`valueBasis` in its meta) read `production_price` per bale as a production/selling value, never as the bale cost.
- **Schema:** `factory_pos_sale_bales`, `factory_stock_value_events`, `factory_bale_recost_runs` (declared in `shared/schema/factory/cost-basis.ts`, created at boot by `ensureFactoryCostBasisSchema`, fatal on failure).
- **Left for other wave-11 agents (their files):** refuse an ERP sale or transfer of a bale-mirror item after the cut-over (POS, transfers); refuse offload of non-USD raw stock with no confirmed rate under perpetual (offload lifecycle).
- Test: `wave11-factory-cost-basis`; updated `bale-cost-backfill-exact`.

#### Wave 11 follow-ups (2026-10-08)

Changed:
- **Closing-stock reports** (`reportsClosingStockRoutes.ts`): the summary, the group detail and the carry-forward value each row with `countedStockRowValue(quantity, total_value)` over every non-deleted location (inactive ones included), bale-mirror items at zero value, so the report total equals `companyStockValuation().total`. They used quantity × average_rate over active locations only.
- **GC migration preview** (`sp-migration/_helpers.ts`): `total_value` is `inventory.total_value`, not ROUND(quantity × average_rate, 4).
- **Settlement variance:** verified, nothing to add. Transfers (create, edit, lifecycle, delete, silent transfer) post the net of their legs (the variance) against COGS; credit notes post the gap to COGS; location imports and stock adjustments offload the whole sub-ledger change to their own counter-account (the adjustment's difference line goes to INVENTORY_ADJUSTMENT, not COGS — see remaining).
- **value_moved convention** documented in `valueExactReversal.ts` (direction from the document; `container_offload_items.value_moved` is the one signed column). Fixed the as-of replay of an offload line that returned stock (negative quantity): it was replayed as a receipt of a negative amount.
- **Stock-adjustment type** compared trimmed and case-insensitively in the inventory line (`stockAdjustments.ts`), the history replay and the reversal/edit/toggle paths: an imported ` consumption ` line is an issue.
- **Charge voucher edits** keep their posting identity: `PUT /api/vouchers/:id/with-entries` never touches `accounting_posting_requests`. The missing marker seen in tests is the test harness (`tests/voucherRequestIdentityTestBridge.mjs` clears posting requests after every test). The stock-in journal's match by charge number stays for legacy charge vouchers without a marker.
- **Bale-mirror items after the cut-over:** ERP POS create/edit, POS import, credit-sales import, stock transfers (both create routes, edit, lifecycle) and silent transfer refuse an item of `factoryBaleMirrorStockItemIds` with 409 `FACTORY_BALE_MIRROR_STOCK` (`assertNoBaleMirrorMovementTx`, translated message).
- **Offload of non-USD purchase orders** (`offload-lifecycle/execute.ts`): under perpetual inventory (cut-over applies to the offload date, not a supplier partner) an offload, replace or edit of a container with a non-USD purchase order is refused with 409 `CONTAINER_OFFLOAD_CURRENCY_RATE_UNCONFIRMED` (translated); ERP purchase orders carry no exchange rate, so there is no confirmed rate to value the stock at. Before the cut-over unchanged.
- **Factory access boundary:** `/bale-cost/*` (reviewed re-cost) requires Factory Settings like the other cost repairs; it had no owner and was denied for every user. The retired `/bales/backfill-costs` (410) left the Settings list.
- **Factory value events:** raw-stock deduct-received and its restore (WASTE), mix finalize (WASTE, remaining kg), mix delete (MATERIAL_PRICE, the reverse of the create) are measured with `withFactoryValuationEventTx`. A carry-forward now moves the leftover kg at exactly the closed mix's cost per kg (decimal), so it adds no drift.
- **`getStableSupplierCost`** never reads a native cost as USD: a row with no `cost_per_kg_usd` is listed in `unvaluedRowIds` and makes the fallback 0 (no rate); every reader (locked-rate back-fill, read-only and bulk reads, supplier-rate recalculation) treats 0 as no rate.
- **Reconciliation:** the factory lines on a past date say they are today's costing (`asOfBasis: "current"`, explicit basis text). A historical factory valuation is not feasible from the data: raw kg, mix kg and bale/mix costs are rewritten in place (deductions, mix edits/deletes, recalculations, cascades) and bale status changes carry no dated history.
- **Ratchets:** float-money baseline lowered (`mix-batches/consume.ts` 3 → 0); write-evidence re-pinned (`reportsClosingStockRoutes.ts` left the backlog, ceiling 17); the daybook container-cost narration is translated.
- Tests: `wave11-followups`, `wave11-followups-factory`; updated `closing-stock-report-exact`.

Remaining:
- A stock-adjustment production into short stock posts its settlement variance to INVENTORY_ADJUSTMENT (the voucher's difference line), not COGS as owner decision 2 says; splitting needs the variance per line.
- Raw-material ADD/REMOVE adjustments (`factory_raw_material_adjustments`) are not in `factoryStockValuation` at all, so they change no factory value and record no event; a manual purchase's Dr Factory Raw Material Stock is reversed by the daily factory journal into Production Variance. Consumption (daily usage) stays in Production Variance (it is production).
- Raw-stock receipt edits/deletes (`PATCH/DELETE /api/factory/raw-stock/receipts/:id`) are not tagged.
- Other ERP sale paths (sales voucher create, optional-sale toggle) do not check the bale mirror.

### Wave 8.4 continuation — factory revenue, receivables and payables in the ledger (2026-10-09) — complete in code

Owner decisions, 2026-10-09 (binding): a factory POS sale posts at the factory's confirmed rate on or before its date, and a non-USD sale with no such rate is refused; a credit sale credits revenue in full and debits cash for the deposit and the customer's own ledger for the unpaid part; container commission posts `FACTORY-COMM-{container}`, replaced on change and removed with the commission or the container; legacy containers are listed, not back-filled. Re-audit items closed: "Factory POS posts at rate 1 and leaves credit revenue out of the GL", "Factory FX rates ignore the transaction date", "Factory daily journal credits expense accounts for commission" (commission part).

- **Date-aware factory FX** (`services/factory/factoryFxRateOnDate.ts`):
  - `findFactoryFxRateOnOrBefore(executor, company, currency, date)`: the latest manual rate dated on or before the date, else the latest recorded (auto) rate dated on or before it; USD is 1; none is `null`. It never fetches, so it is used inside posting transactions.
  - `getOrFetchFxRateToUsd` (`routes/factory/_helpers.ts`) and its read-only twin (`factoryFxRateReadOnly.ts`) keep their precedence but date-bounded: manual on or before the date, the rate recorded for exactly that date, the external historical rate (the mutation records it as an auto row dated that day; the preview never persists), then the latest recorded rate on or before the date. They used to take the most recent manual rate whatever its date, and fall back to the most recent row of any date. Example: CFA rates 0.0016 from January and 0.0020 from June; a March transaction was priced at 0.0020, it is now 0.0016.
  - `writeDaybookEntry`: a non-USD entry written with no rate takes the confirmed rate on or before its date; with none it is stored with rate 0 and `amount_usd` 0 (unresolved, as `resolveStoredFxRate` reads it) and logged. It used to store rate 1 and the native amount as USD.
- **Factory POS sale** (`services/accounting/factoryPosReceipt.ts`, `pos-financial/sale-write.ts`, `sale-delete.ts`):
  - One voucher `FPOS-RCPT-{sale}` (sale ids are unique across companies), posted through the infrastructure voucher writer with a posting identity, replaced whole on every edit and removed on a void. It used to be `FPOS-{sale}-{timestamp}`, matched by `LIKE` on edit, never removed on a void, and not created by an edit when the sale had none. An edit or void of a legacy sale removes its `FPOS-{sale}-…` voucher too.
  - Lines, normalized like wave 6 (USD base = native × rate in `debit/credit`, native in `transaction_*`, the factory rate as historical rate, `BASE_PER_TRANSACTION`; the header carries the sale currency and the rate): Dr/Cr cash = received (the total for a cash sale, the deposit for a credit sale) less the deductions, credited when the deductions exceed it; Dr each deduction account; Dr the customer's ledger (`CUST-{id}` via `customerLedgerAccountTx`, now exported from `factoryInvoice.ts`, with `customer_id` on the line) for the unpaid part, credited for a deposit above the total; Cr Factory Bale Sales Income for the full total. Balanced by construction. Voucher type Receipt with a cash leg, Journal without one.
  - Before: rate 1 with native amounts in the USD columns; a credit sale posted only Dr cash / Cr income for its deposit; deductions above the cash received left the voucher unbalanced (Dr capped at 0, Cr gross), so the balance guard refused the sale; no cash account meant no voucher at all.
  - Refusals before any write: a non-USD sale with no confirmed rate on or before the sale date — 409 `FACTORY_POS_RATE_UNCONFIRMED`; a non-zero cash leg with no cash account — 400 (decision: refuse, there is no account to debit; a credit sale with no deposit and no deductions needs none and posts the receivable only); an unpaid credit sale with no customer — 400 (it used to post its revenue nowhere); a customer of another company — 400 "Customer not found". Messages are fixed English sentences in `wave8ReleaseTranslations.part3.ts`.
  - The sale's daybook rows (`BALE_SALE`, `POS_EXPENSE`) carry the sale-date rate and USD amount (they stored rate 1 and the native amount as USD); an edit updates their currency, rate and USD amount.
  - `customer_balances` keeps its operational rows. An edit now always removes the sale's old `FACTORY_POS_SALE`/`FACTORY_POS_DEPOSIT` rows before re-writing them for a credit sale (they stayed when an edit turned a credit sale into a cash sale). A void still leaves them (unchanged).
  - `FPOS-COGS` unchanged.
  - Example: a cash sale of 100,000 XOF on 15 March with rates 0.0016 (January) and 0.0020 (June) posted Dr cash 100,000 / Cr income 100,000 in the USD columns; it posts Dr cash 160.00 / Cr income 160.00 USD (100,000 XOF each in `transaction_*`, rate 0.0016). A credit sale of 200 with a 50 deposit posted Dr cash 50 / Cr income 50; it posts Dr cash 50, Dr CUST 150 / Cr income 200.
- **Not-in-ledger memo** (`balances/unpostedMemo.ts`): a POS credit sale's `FACTORY_POS_SALE`/`FACTORY_POS_DEPOSIT` cache rows are no longer listed when the sale has a live `FPOS-RCPT` voucher (it carries the receivable) or is voided. Sales posted before (deposit only) stay listed until edited.
- **Container commission** (`services/factory/containerCommissionJournal.ts`): `FACTORY-COMM-{container}`, Journal, through the infrastructure voucher writer: Dr the account the container's live `FACTORY-IMPORT` voucher debits (else Factory Import Cost) / Cr the commission payee — the commission supplier (broker) when set, else the container's supplier (a factory-supplier line), else the container's commission ledger account. Normalized at the commission's confirmed rate, or the container's confirmed rate for a commission in the container's currency. Nothing is posted with no rate or no payee (listed instead). Wired in the same transaction as the commission write: container create (the insert and the journal now share a transaction), update (the container update, freight voucher sync and commission journal now share one transaction; synced when a commission, supplier, currency, rate or arrival-date field is in the request), Excel import, offload, reverse offload, the daybook commission edit; single container delete removes it. Bulk delete is a restorable soft delete that keeps all container vouchers, as before. The factory supplier pages read only debit voucher lines as payments, so the journal's credit is not counted twice there (the old comment in `create.ts` saying a journal would double count is replaced).
  - Legacy containers with commission and no journal: listed by the integrity diagnostic (`factory_container_commission_not_journalled`, warn) and by the factory-supplier memo (`factoryContainerCommission`), which now matches `FACTORY-COMM-{container}` exactly (and the old `-…` form) and lists the line under the party the journal credits (commission supplier, else the container's supplier; it was always the container's supplier). Not back-filled.
- **Daily factory stock journal** (`factoryStockJournal.ts`, unchanged): it already spreads a receipt's USD value over the expense accounts the container's `FACTORY-(IMPORT|COMM|FREIGHT|OC|POC)-{container}` vouchers debited. With the commission now debited to the import cost account, the receipt credit (landed value incl. commission) lands on accounts that were charged: goods 2,000 + commission 500 debited, 2,500 received, net 0 on Factory Import Cost (it was a 500 net credit). Legacy containers without a commission journal keep the old effect.
- **Remaining:** commission recorded on raw stock rows (`factory_raw_stock.commission_*`, opening-balance entries) and in `factory_container_commissions` is not journalled separately (the offload copies it onto the container, which is); legacy POS credit sales and legacy commission stay in the memo until edited; a POS void leaves its `customer_balances` rows; non-USD auto rates (external) count as recorded rates for the POS lookup.
- Tests: `wave8-4-factory-pos-commission`; updated `phase33d-pos-sale-write` (the voucher legs moved into the service, checked through its helpers; a credit sale's deposit and a cash sale now need a cash account) and `wave11-factory-cost-basis` (its unpaid credit sales now name a customer; cleanup removes `customer_balances`).

### Wave 12 (B) — audit trail and destructive routes (2026-10-09) — complete in code

Owner decisions 2–4 (binding): edits to posted vouchers stay allowed in open periods but are audited with a full before/after snapshot inside their transaction; audit_log is append-only except for the retention job, which keeps financial rows forever; a company with history can never be erased.

- **audit_log append-only** (`services/audit/auditLogAppendOnlyGuard.ts`, installed on every boot after the voucher balance guard, versioned `2026-10-audit-log-append-only-v1`, fatal on failure): a BEFORE UPDATE OR DELETE row trigger refuses every change (`AUDIT_LOG_APPEND_ONLY`, SQLSTATE 42501) and a BEFORE TRUNCATE trigger refuses TRUNCATE. The only exception is a DELETE in a transaction that set `app.audit_log_maintenance = 'retention'` (transaction-local) of a row whose `table_name` is not financial. The financial list is one constant, `FINANCIAL_AUDIT_TABLES` + `FINANCIAL_AUDIT_TABLE_PREFIXES` (`services/audit/auditLogRetentionPolicy.ts`: vouchers, lines, ledger, banks, parties, stock/inventory, sales/purchases, payroll, fiscal, companies, every `factory_*` table, …), compiled into `erp_audit_log_is_financial()`. Both triggers are listed in the diagnostic's `database_guards_installed`.
- **Retention**: the scheduled job (`remoteSupportAuditRetention.ts`, the only audit pruning in the code) now runs in one transaction with that setting and excludes financial rows in its own WHERE as well; it still prunes only remote-support rows (180 days / 100k rows). Removed every other audit_log delete: the company-delete cascade (both implementations), and `audit_log` in `scripts/wipe-company12-data.ts`.
- **Audit inside the transaction** (`routes/helpers/voucherAuditTrail.ts` `writeVoucherAuditTx`): the audit row carries the readable summary as before plus `voucher` (header row before/after) and `entryRows` (every line row before/after). Written in the edit's transaction — a failed audit insert rolls the edit back — in: `PATCH /api/vouchers/:id` (including the POS date edit on stock transfers, which was unaudited), `PATCH /api/vouchers/:id/optional`, `DELETE /api/vouchers/:id` (both handlers), `POST /api/vouchers/bulk-delete` (per voucher), `PATCH /api/vouchers/:id/journal` (central and legacy), Payment/Receipt create and update, journal create, `PUT /api/vouchers/:id/with-entries`, and the inter-company counterpart rescale those edits make (audited under the counterpart's company). The after-commit `try { logAudit } catch { /* non-fatal */ }` blocks there are gone. `PATCH /api/voucher-entries/:id` now audits narration-only edits (unaudited before) and adds the whole line before/after to amount edits. `logAudit` (adapter) takes an optional executor.
- **No truncation of line snapshots**: `sanitizeAuditChanges` keeps every element of the change fields in `FULL_SNAPSHOT_AUDIT_FIELDS` (`entries`, `entryRows`, `lines`, `items`, `salesItems`); each element is still sanitized. Other arrays stay capped at 100. Example: deleting a 120-line voucher stored 100 lines; it now stores 120.
- **Employee balances on the caller's transaction**: `syncEmployeeBalancesFromEntries(entries, companyId, reverse, executor)` — the executor is required, and every caller (voucher create/update/delete/bulk-delete/optional, journal and payment routes, ERP payroll bonuses, deposits, withdrawals, bulk adjustments) passes its transaction; the calls that ran after commit now run inside it. It reads the EMP- accounts on the executor too.
- **Company delete** (`storage/company-deletion.ts`; `storage/auth.ts` legacy cascade retired and delegating; `DELETE /api/companies/:id`): Owner only (`requireRole("Owner")`, Developer passes as with every requireRole) and the Owner must be Owner of the target company. One transaction: refused 409 `COMPANY_HAS_HISTORY` (with `blockers`) while the company has any voucher (deleted ones included), fiscal closure, inventory row with quantity or value, factory raw stock or bales, or a non-zero opening/balance on ledger accounts, banks, customers (and customer balances), suppliers, factory suppliers, employees or fixed assets — deactivate it instead. Otherwise an audit row (`companies`, the full company row, `company_id` kept as a retained reference; audit_log has no FK) is written first, then the empty company's configuration rows are deleted. audit_log is never deleted.
- **Permanent delete** (`routes/admin/deleted-items/permanent-delete.ts`): orphaned POS sale — Admin/Owner only (was any non-POS user), refused 409 when it has ledger lines **or** sold-item lines (it is posted; deleting it as a voucher soft-deletes it and reverses its stock), otherwise one transaction, audited with the header. Employee — refused 409 while any voucher line (live or deleted voucher), salary advance or payroll run item names it (lines used to have the employee cleared and advances/payroll rows were deleted); otherwise one transaction (was autocommit), audited. Customer — refused 409 while any voucher line, container sale or factory POS sale names it (lines and POS sales used to have the customer cleared, container sales were deleted); otherwise one transaction, audited. Messages are translatable (`wave8ReleaseTranslations.part3.ts`).
- **Atomic writers**: `POST /api/salary-advances` writes the voucher, its two lines and the advance row in one transaction and audits both (voucher snapshot and `salary_advances`) in it (each autocommitted before; a failing second line left a one-line voucher). `maybeRunAutoTransfer` (rental) writes both companies' vouchers, their lines, any TRANSFER-CLEARING account it creates and the `inter_company_transfers` link in one transaction (a failure on the destination side used to leave the source company's money out). A failure is still logged and does not undo the rent payment, which committed before.
- **Test cleanup**: tests remove their own audit rows with `deleteAuditLogRowsForTests` (`tests/helpers/auditLogCleanup.ts`, superuser `SET LOCAL session_replication_role = replica`, rows left in place when the role cannot); `tests/setup.ts` and every test that deleted audit_log use it.
- **Tests**: `tests/wave12-audit-trail.test.ts` (append-only and retention, rollback when the audit insert fails, 120-line delete snapshot, company delete refused/allowed/audited, orphaned POS / employee / customer permanent delete, salary advance and rental auto-transfer atomicity, employee balance rollback). Updated: `backend-coverage-company-lifecycle-storage` (pinned the old cascade that deleted vouchers and audit_log), `employee-balance-sync-exact` (executor argument), `voucher-journal-routes-behavior` (sync and audit now on the transaction).
- **Not done here**: voucher *create* routes outside the journal/payment files (`voucherCreateRoutes.ts`, POS, factory writers) still write their create audit after commit; posted lines are still rewritten in place by edits (reversal-instead-of-edit was not decided); the retention job prunes only remote-support rows (no general non-financial pruning was added).

### Wave 12 (A) — ledger integrity (2026-10-09) — complete in code

Owner decision 1 (binding) and the section 8 re-audit items on the balance guard, fiscal close, opening balances, zero-balances and the company import.

- **Balance guard v3** (`voucherBalanceGuard.ts`, `2026-10-voucher-balance-v3`; the installer replaces v2 in place, is idempotent, waits at most 15 s for its locks and is now **fatal at boot** like the closed-period guard):
  - **History marker**: `vouchers.balance_guard_exempt_history`, added once with `DEFAULT true` (every voucher existing at the first v3 install is history; catalogue-only, no rewrite, no trigger fires) and then `DEFAULT false`. `vouchers_balance_guard_history_marker` forces it to false on every insert and refuses any change to it — no application path, bypass setting, backdated `created_at` or imported field can mark a voucher history. `created_at` and the v2 `voucher_balance_guard_since` setting are no longer read (the setting is left in place, unused). The column is not in the Drizzle schema: full-row selects are unchanged.
  - **Stock types** (Stock Adjustment, Production, Consumption, Mixed) are exempt only when the voucher has `stock_adjustment_items` rows (through `stock_adjustment_vouchers.voucher_id`) **and** all its lines are on one side, before a non-supplier-partner company's cut-over or in a supplier partner (as before). A two-sided stock voucher must balance; from the cut-over every stock voucher must balance (v2 rule). Removing a stock document (`stock_adjustment_vouchers` / `stock_adjustment_items` delete or re-link) re-checks the voucher.
  - **Columns**: the base columns (`debit_amount`/`credit_amount`) are always checked, rounded to cents. When every line shares one transaction currency, the transaction columns must balance to the cent and the base may differ by at most 0.01 (per-line conversion rounding); otherwise the base must balance exactly. Before: single-currency vouchers were checked in the transaction currency only.
  - The vouchers trigger now also fires on `voucher_type` and `created_at` changes.
- **Stock adjustment writers are the only creators** (`services/accounting/stockVoucherTypes.ts`): the generic routes answer 400 `STOCK_VOUCHER_TYPE_NOT_ALLOWED` (translatable) for the stock types — `POST /api/vouchers`, `POST /api/vouchers/with-entries` (central and legacy handlers), `POST` and `PATCH /api/voucher-entries` on a stock voucher, `PATCH /api/vouchers/:id` with `entries` on a stock voucher (header-only edits stay), and `PUT /api/vouchers/:id/with-entries` on a stock voucher or re-typing to/from one. The journal and payment/receipt routes fix their own types; the POS, credit-sales and stock-transfer imports create Sales/Stock Transfer only. `POST /api/stock-adjustments` now accepts a `voucher` header instead of `voucherId` and creates the voucher and its adjustment in one transaction (`createStockAdjustmentWithVoucher`); it requires `act_create_voucher`, which the form's old `POST /api/vouchers` call required. The stock adjustment form and the chat assistant use it. An existing `voucherId` is still accepted. The create and edit writers post a Mixed adjustment as **one net line** on STOCK_ADJUSTMENT (`stockAdjustmentNetLine`); they used to write a Cr production line and a Dr consumption line on the same account, the two-line unbalanced Mixed vouchers production holds. Same ledger effect.
- **Company import** (`routes/factory/docs-users/companyImportRoutes.ts`): refused 400 `IMPORT_UNBALANCED_VOUCHERS` (lists them) when any posted voucher in the file does not balance to the cent, stock types included — the file carries no stock documents, so a one-sided stock voucher would not be exempt. Refusing was chosen over importing them as history: the marker cannot be set after install by design. The file's `created_at` is still copied; it no longer affects the guard, and a `balanceGuardExemptHistory` field in the file is ignored (the insert trigger forces false). An audit row (`companies`, action `import`, source company, file name, per-table counts) is written inside the import transaction.
- **Fiscal close** (`storage/accounting/fiscal-periods.ts`): the closing line of each Income/Expense account is the opposite of its balance **through the period end** (opening + every posted entry dated by `COALESCE(effective_date, voucher_date)` on or before it, earlier closing journals included), and **openings are left in place** (choice: include and leave). Before, the line included the opening and the opening was also zeroed, so each P&L opening was closed twice; activity was dated by `voucher_date`. After a close every P&L account is exactly zero at the period end and retained earnings move by exactly the net profit closed. New closures store an empty opening snapshot; a legacy closure (null snapshot) is still reconstructed on reopen. A later close after a legacy close posts the legacy double count back automatically (its balance through the new end includes it).
- **Opening balances under the period lock** (`services/accounting/openingBalanceLock.ts`, `2026-10-opening-balance-lock-v1`, installed at boot after the closed-period guard, fatal on failure): BEFORE triggers on `ledger_accounts`, `customers`, `suppliers`, `bank_accounts` and `employees` refuse a non-zero opening on insert, a changed opening amount or side, or moving a record with an opening to another company, once the company has **any** closed fiscal period (choice: any close, not "opening date in a closed period" — openings predate the first period). The refusal uses the closed-period SQLSTATE and is answered 409 with a translatable message by `PUT /api/ledger-accounts/:id`, `POST /api/ledger-accounts`, `PUT /api/customers/:id`, `PATCH /api/suppliers/:id`, `PUT /api/bank-accounts/:id` and every route using `errorStatus`. Allowed opening edits keep their existing audit. Bypass: the maintenance scope or `app.closed_period_override` (the fiscal reopen uses it to restore a legacy close's openings). Not covered: fixed assets and factory suppliers.
- **`POST /api/ledger-accounts/zero-balances`**: Owner only (was Admin), one transaction (was one autocommit per account), refused 409 after a close, and audited inside the transaction with every account's previous opening and side.
- **Diagnostic** `database_guards_installed` also lists the five balance-guard triggers, the five opening-lock triggers, the balance guard version (`erp_voucher_balance_check v3`) and the history marker column.
- **Tests**: `tests/wave12-ledger-integrity.test.ts`. Updated: `voucher-balance-guard` (history via the marker instead of `created_at`; stock vouchers need a stock document; drops every v3 trigger on cleanup), `fiscal-period-close-reopen` (openings stay after a close; the legacy-reopen case now sets up a real legacy state: null snapshot and zeroed opening), `voucher-mixed-negative-total` (a Mixed voucher with a negative net total now comes from `POST /api/stock-adjustments`; `POST /api/vouchers` refuses Mixed), `wave9-ledger-safety-routes` (re-typing a Journal to Mixed / Stock Adjustment now gets the stock-type refusal), `write-route-guard-sweep` (zero-balances is a sensitive write route now that it writes in its own transaction).
- **Not done here**: the integrity diagnostic's `single_sided_stock_vouchers` still classifies by type only; fixed-asset and factory-supplier openings are not locked; the company import has no role check beyond the factory settings page.

### Wave 13 (A) — reports (2026-10-09) — complete in code

Section 8 re-audit items R1, C1, R2, R3, R4, R5/X4, the remaining exact-string type filters and the `non_canonical_account_types` check.

- **Balance sheet on the classifier (R1, `financialReportsService.getBalanceSheet`).** Every ledger row is classed by `classifyAccountType` (type and sub type): asset, liability, equity (Equity, Profit), income/expense into current earnings (Government Taxes, Revenue, COGS, mis-cased types), party (Intercompany, Customer/Supplier ledger accounts) by the side of its balance, unknown types unclassified. Before, Government Taxes was a liability and Profit was in current earnings. Current earnings now equal `getProfitLoss` net profit to the same date (P&L accounts carry no openings in the fixture; an income/expense opening is in current earnings but not in `getProfitLoss`, which reads lines only); the difference is still the trial balance's.
- **`getProfitLoss` sign fix (found by the new test).** Expense items carried credit − debit, so `totalExpenses` was negative and `netProfit` = income − expenses *added* the expenses. Expense balances are now debit − credit. **Meaning change** for `/api/reports/profit-loss`: `expenseItems[].balance` and `totalExpenses` are positive, `netProfit` is income − expenses.
- **Sideless ledger openings (C1, `ledgerBalanceEngine.ts`).** A ledger account's opening with no side takes `defaultOpeningSide(accountType)` (Dr asset/expense, Cr liability/equity/income/supplier/intercompany); other masters keep their record-type side, and an unknown ledger type keeps Dr. `openingSideAssumed` and the trial balance's `openingSidesAssumed` still count them. The trial balance, balance sheet, party balances and every engine net position agree with the net-profit workbook's rule. The chat ledger-balance report (phase 5) uses the same default.
- **One date basis (R2): `COALESCE(effective_date, voucher_date)`** in `getProfitLoss`, `calculateIncomeStatementForPeriod`, the dashboard, the ratios, the net-profit workbook (period, months, sales) and its drill-downs, and every date filter of the chat report shards (phases 1–7).
- **Dashboard (R3, `dashboardStatsService.ts`).** `/api/stats/monthly-data` buckets by year-month and returns `yearMonth` beside `month` (last year's October was added into this October). `sales` is the net income-class credit of Sales vouchers in base amounts (was `totalAmount` in each voucher's currency); `profit` is income − expense over every classifier account, i.e. the P&L's net profit for the month (the code/name list of "capitalised" import charges is gone). `/api/stats/expense-breakdown` takes every expense-class account by `expenseCategory`, Purchases and IMPORT_CHARGES included, as the P&L does.
- **Ratios (R4, `getFinancialRatios`, `/api/reports/ratios`).** Income, expenses and net profit are `getProfitLoss` over the range; assets and liabilities are the balance sheet's totals at the range end (closing balances with openings, banks, fixed assets, parties by side); equity stays assets − liabilities; sales items only from live, non-optional vouchers. Before: exact types only, deleted and optional vouchers read, period movements of asset/liability accounts used as balances.
- **Net-profit workbook (R5/X4).** The workbook's own net position (USD-base Cash divided by the CFA rate, payroll from `employees.current_balance`, no banks or customers) is replaced by `calculateNetPositionAsOf` as of the period end (today for all time). The sheets never printed it and their layout is unchanged; the figure is recorded in the workbook description (`Net position as of <date>: <amount>`). P&L sections come from `netProfitSection` (classifier): plain `Expense` and Government Taxes, missing from every section before, are indirect expenses; COGS is a direct expense; Indirect Income has its own section below gross profit (net profit = gross profit + indirect income), shown only when present. The report-characterization pin did not change (its fixture has none of these).
- **Net-profit statement drill-downs** list exactly the workbook's sections and take optional `startDate` / `endDate` (they had no date filter). Chat phase 2/3/7 shards: payables aging, monthly comparison, expense and income breakdowns, and Cash/Bank lists match types through the classifier (case-insensitive).
- **Diagnostic `non_canonical_account_types`** flags only types the classifier reports as unknown; COGS, Revenue, Current Asset and mis-cased types are accepted.
- **Tests**: `tests/wave13-reports.test.ts`. Updated: `accounting-integrity-trial-balance` (the flagged type is now one the classifier does not know; `EXPENSE` is an expense), `wave10-account-classification` (P&L expense balances are positive), `dashboard-monthly-data-exact` (one query, sales from posted income lines).
- **Not done here**: chat shards still sum `debit_amount` by `la.company_id` without `v.company_id` in a few P&L queries and keep parseFloat sums; the customer aging shard still defaults a sideless opening to Dr; the dashboard expense breakdown has no date range.

### Wave 13 (B) — payables, statements, group (2026-10-09) — complete in code

Owner decisions 1–3 (binding) and section 8 items A1, A2, A3, A4/M3, M1, M2.

- **ERP suppliers on the engine (A1).** `getSupplierBalanceForContext` (`routes/helpers/supplierBalanceHelpers.ts`) is the engine's kind `supplier` in the voucher company, batched by `routes/performance/supplierVoucherEntryBatcher.ts` (one `getPartyBalances` per company/window, one owned-lines query per company): the supplier's opening with its side, counted only in the supplier's own company, plus the lines the engine attributes to it, dated `COALESCE(effective_date, voucher_date)`, netted. The ownership rule is `partyLineRules.higherPriorityTargetsAbsent` (new): a supplier-tagged line on a ledger account, bank or fixed asset is that account's line. Readers: `/api/suppliers/stats`, `/api/suppliers/:id/balance` (adds `openingBalanceSide`, `balanceBasis`), `/api/accounts/all` (supplier rows), `/api/accounts/payables` (now one engine call; it used to loop over every company's suppliers). The supplier statements (`/api/accounts/supplier/:id/transactions` paginated and plain, the pre-period balance, the account statement PDF and Excel) list the same owned lines (`getVoucherEntriesBySupplier(..., { ownedOnly: true })`) and open at the engine's period opening. **Meaning changes:** a supplier-tagged bank/ledger line is no longer counted on the supplier (it was counted twice across the trial balance); a supplier opening now carries its side in the PDF/Excel/pre-period statements (always Cr before) and no longer depends on the global `parentCompanyId` setting; a subsidiary that posted to a parent's supplier sees the lines it posted (it saw zero), and stats lists such a supplier with `postedFromOtherCompany: true`. Supplier-partner companies post their supplier credits on the SP payable ledger with the supplier tagged, so their Suppliers-page balances now show only lines naming the supplier alone; the SP payable is the ledger account's (as in the trial balance). The unified supplier ledger (`/api/suppliers/:id/unified-ledger`) and the SP reconciliation keep reading every supplier-tagged line (SP payable evidence, by design).
- **Factory supplier pages (A2, owner decision 3).** `routes/factory/suppliers/balance/factorySupplierLedger.ts`: the ledger view per factory supplier — engine kind `factorySupplier` (USD base, Cr positive), the native balance per currency of the same lines from their transaction columns (legacy lines in the voucher's currency, counted in `legacyUnconvertedLines` / `ledgerFxUnresolved`), and the engine memo lines as `notInLedger` (`total`, `unresolved`, `lines`). `GET /api/factory/suppliers/:id/balance`: `balance`/`outstandingUsd` are the ledger balance; adds `ledgerBalance`, `nativeBalances`, `notInLedger`, `notInLedgerTotal`, and `operationalMemo` (the container formula, labelled). `GET /api/factory/suppliers/with-balances`: `totalValue` and `currencyBalances` are the ledger's (the card's FX settle buttons use the ledger native balance); a broker's `totalValue`/`brokerPoolUsd` are its own ledger balance, `linkedSupplierExposure` and `exposureCurrencyBalances` the linked suppliers' ledger balances; the operational totals, pools and exposure are in `operationalMemo`. The statement adds `ledgerView` (view + the owned lines with a running USD balance) and `summary.ledgerBalance`, `summary.notInLedgerTotal`; `summary.netPayable` is now the ledger balance and the container figure moved to `summary.operationalNetPayable` (the per-currency `currencyGroups[].netPayable` stay operational). The broker statement and the broker visual statement add `ledgerView` (broker and linked suppliers). **Meaning change:** every primary factory supplier balance is the ledger; legacy containers and commission without journals now show only as "not yet in the ledger". Operational memo fixes: freight in a third currency (neither the container's nor USD) converts at its own confirmed freight rate and is flagged unresolved without one (it was dropped from the single balance and converted at the container's rate on the list); other charges and commission in a currency other than the container's are no longer converted at the container's rate (flagged unresolved instead). The visual statement excludes soft-deleted containers, dates voucher payments by effective date and defaults freight to the container's currency. Client: the supplier list shows "Ledger balance" and the memo total; the statement page shows a ledger panel (USD, per currency, not-in-ledger lines, operational memo) — `LedgerBalancePanel.tsx`, translations en/ar/fr in `wave8ReleaseTranslations.part3.ts`. `unpostedMemo.ts` needed no change (it already uses the freight's own rate).
- **Customer statements (A3).** `/api/customers/:id/transactions` and `/api/pos/customers/:id/transactions` list `loadCustomerLedgerEntryRows` (the engine's `customerOwnedLineSql`, this company only, effective date), so opening + lines foots to the balance the page shows. Before, a linked customer listed every line on its ledger and an unlinked one every customer-tagged line of every company (a bank or sales line tagged with the customer counted).
- **Chat and alerts (A4/M3).** `chat/erpContext.ts`: suppliers and customers from `getPartyBalances` of the company (Decimal sums): `supplierBalances` lists only the company's suppliers plus suppliers of another company it posted to (it listed every company's active suppliers); `totalReceivables` is the engine closing (it was the `customer_balances` cache) and `financialSummary.receivablesNotInLedger` the memo, shown apart in the prompt. `/api/chatbot/alerts` `overdueCustomers` are the engine closings (largest first, with `notInLedger`), plus `receivablesNotInLedger`.
- **One supplier-inclusion rule (M1, owner decision 2).** The live net position (`statsNetProfitRoutes`), the net-position Excel (`statsNetPositionRoutes`, which used the global `parentCompanyId` setting) and `calculateNetPositionAsOf` (monthly Excel, schedulers; `companies.parent_company_id`) always include ERP supplier payables in the posting company (`ERP_NET_POSITION_INCLUDES_SUPPLIERS`, `netPositionParties.ts`). `netProfitDataLoad` no longer loads the setting. The factory net position is unchanged (factory suppliers). A supplier line posted to another company's supplier is shown under that supplier's name. Supplier-partner rules (customers excluded, SP payable on the ledger) are unchanged; their PO-import supplier credits are posted in the parent, so nothing moves. **Meaning change:** a subsidiary's net position now carries the supplier payables it posted. Not changed: `routes/import-cycle/balance.ts` still gates on the global setting.
- **Paired group elimination (M2, owner decision 1)** (`helpers/groupNetPosition.ts`, `helpers/groupIntercompany.ts`). Per company, in its own scope, the intercompany accounts are taken from what is recorded: `inter_company_transfers` (from/to ledger with the other company), `intercompany_pos_configs` (source/destination interco accounts), the PO-import parent-credit pair (the subsidiary's `company_settings.parent_credit_account_id` with its parent; in the parent, the receivable the PO import itself finds by the exact name "<subsidiary> Credit"), and every account typed Intercompany. They leave the company lines (by id) with their value; companies linked by them form a set (normally a pair) whose receivables are eliminated against the payables; any remainder, and any account whose counterpart is not a company of the report or not recorded, is an "Intercompany difference" line in the group totals (`intercompany.differences`, `pairs`, `additionalElimination` = the matched amount, `mode: "paired-elimination"`). Removed: the name/code exclusions (`IC-TO-`/`IC-FROM-` codes, names containing "intercompany", the "hmd international group lebanon credit" name) and the hard-coded HADI L'SHI exception — no test or configuration shows that account as a group pair, so it is now an ordinary account on both sides. The group Excel and page show the difference lines. `JNAH` stays an excluded company code (company eligibility, not elimination). **Meaning change:** mismatched intercompany balances (and Intercompany-typed accounts with no recorded counterpart, which the classifier leaves out of every company) are now visible in the group total.
- **Tests:** `tests/wave13-payables-group.test.ts` (supplier = engine with a supplier-tagged bank line, company filter and the shared supplier; factory supplier USD + native + memo + operational memo flag; customer statements foot; chat receivables, supplier list and alerts = engine; subsidiary payable in its net position and once per company in the group; paired elimination with a mismatch, a matched pair and an unpaired account). Updated (pinned the replaced behaviour): `group-net-position` (name/HADI exclusions → recorded pairs and a difference; mode), `group-net-position-excel` (snapshot type), `supplier-parent-fallback` (the opening side is no longer preloaded; new repository call), `money-exact-batch-19` and `wave10-party-reader-rules` (balance from the engine, per-currency view from the lines), `account-statement-routes-behavior` (supplier pre-period from the engine, not the parent setting), `factory-supplier-single-balance-exact`, `factory-supplier-statement-exact`, `factory-suppliers-with-balances-route`, `phase30-supplier-with-balances-branch-gaps`, `broker-visual-statement-exact` (the container figures they pin are now `operationalMemo` / `operationalNetPayable`), `phase33g-high-line-misc` and `phase33-chat-prompt-behavior` (engine in the ERP context, new summary field), `report-endpoint-characterization` (factory supplier statement pin regenerated: new keys). `scripts/verify-bandwidth-phases-1-2.mjs` marker moved to the new batcher key.
- **Not done here:** the factory supplier FX settlement and payment dialogs still pre-fill from the list's balances (now ledger figures); `historicalSupplierReferenceRoutes` and the unified supplier ledger still read every supplier-tagged line and use the parent setting for the opening; `accounts/all.ts` still hides a child company's inactive suppliers by the parent check; the import-cycle balance keeps its own supplier gate.

### Wave 14 (A) — currency (2026-10-09) — complete in code

Owner decisions 1, 2 and 4 (binding). Re-audit section 8 items closed: "Currency normalization trigger still has no installer", "`POST /api/exchange-rates` is open to any signed-in user and unaudited"; the wave 6 repair can now rate the lines that had no rate.

- **Currency normalization trigger at every boot (decision 4)** (`services/accounting/currencyNormalizationGuard.ts`, `server/index.ts` after the ledger integrity guard). `ensureCurrencyNormalizationGuard` installs `normalize_voucher_entry_currency_amounts()` and `voucher_entries_normalize_currency_before_write` with the definition of `migrations/20260720_005` verbatim (the test pins the text to the migration file), versioned by a COMMENT on the function (`2026-07-20-005-currency-normalization-v1`), skipped when that version and an enabled trigger bound to the function are present, otherwise one transaction under an advisory lock with `lock_timeout = 15s`; fatal on failure. A missing column (fresh schema) skips it with a warning. The integrity diagnostic's `database_guards_installed` lists the trigger and its version. Source of truth: the migration file; production was not queried. Production has a trigger of this name (section 8); if its body differs from the migration, the first boot replaces it with the migration's definition (doubt noted, not measured).
  - **Effect on tests and CI:** CI's backend job boots the app before the tests, so every backend test now runs against the trigger (the test database never had it). Fixtures that wrote a transaction currency without the rate and convention were rewritten by the trigger as legacy lines in the voucher's currency; they now write fully normalized lines (`tests/helpers/normalizedVoucherLine.ts`): `wave12-ledger-integrity`, `voucher-balance-guard`, `wave13-payables-group`. `wave8-4-factory-pos-commission` pinned `XOF` as the stored transaction currency; the trigger stores `CFA` (as production does). No application writer was refused by the trigger in the suites run (list in the wave 14 report).
- **Exchange-rate saves (decision 2)** (`services/accounting/exchangeRateWrites.ts`). `POST /api/exchange-rates`, `POST /api/factory/fx-rates` and `DELETE /api/factory/fx-rates/:currency` are `requireRole("Admin", "Owner")` (Developer passes); Manager, POS and other roles get 403. Each save writes its audit row with `writeAuditEvent(event, tx)` in the rate's own transaction: a company rate with the replaced rate (`old`, null for a new date) and the new one; a factory rate with the manual rate it supersedes on its date and the new one; a factory delete with every removed row. A factory currency code is stored upper-case (a lower-case code was never found by the lookups). Client: the daily rate prompt opens only for Admin/Owner/Developer, and the factory FX rates card hides add/delete for other roles (`client/src/lib/exchangeRateEditors.ts`). Not changed: `GET /api/factory/fx-rates/latest/:currency` and `/:currency/:date` (and `getOrFetchFxRateToUsd` in posting flows) still record the external historical rate as an `auto` row when none is stored; they are a rate cache, not a user save, and are not audited.
- **Wave 6 repair at a dated rate (decision 1)** (`services/factory/factoryFxLegacyRepair.ts`). A legacy line whose voucher has no usable rate of its own (0, null or the default 1) is rated at `findFactoryFxRateOnOrBefore(company, currency, voucher date)` — the manual rate dated on or before the voucher, else the recorded auto rate on or before it; a rate dated after the voucher is never used. Such a line is repaired only when it holds the native amount (the voucher total), since with an unset rate every leg was stored native. Each plan line shows `rate`, `rateSource` (`line` | `dated-manual` | `dated-auto`) and `rateEffectiveDate`; the plan adds `datedRateLines` and `planHash` (sha256 of the lines it would change). A line with no rate at all stays listed (`RATE_NOT_SET`) and untouched. The apply (`POST /api/accounting/factory-fx-repair/apply`, `{"confirm": true}`, Admin/Owner) re-derives the plan under row locks in one transaction, refuses with 409 `FACTORY_FX_REPAIR_PLAN_CHANGED` when the caller sends the reviewed `planHash` and the plan changed (for example a rate was added since), and now writes its audit (old/new amount, native, rate and source per line) in that transaction (it was written after commit). Closed periods and half-convertible vouchers are still skipped. The converted lines are fully normalized (`BASE_PER_TRANSACTION`, base = native × rate to 6 places), the shape the trigger validates. The voucher header's rate is left as stored (each line carries its own rate).
- **Tests:** `tests/wave14-currency.test.ts` (installer: the migration's definition, idempotent, versioned, fatal with rollback and release, skip on a missing column; diagnostic lists an out-of-date version; exchange-rate routes refused for Manager and POS with nothing written, Admin saves audited with old and new, factory save/delete audited; repair: dated manual before auto, a later rate not used, sources shown, a no-rate line listed and untouched, a changed plan refused, the reviewed plan applied through the trigger and audited in the transaction). Updated: the four fixture files above.
- **Production:** the trigger exists there; the installer only adds the version comment (and replaces the body if it differs). The wave 6 repair still has to be reviewed and applied by an Owner/Admin: `GET /api/accounting/factory-fx-repair` now rates the 240 lines without a usable rate wherever a factory rate exists on or before their date; send the plan's `planHash` with the apply.

### Wave 14 (B) — factory and supplier leftovers (2026-10-09) — complete in code

Owner decisions 2026-10-09 (wave 14 plan) and the leftovers of waves 8.4 continuation and 13 (B). Decision 3 (factory POS confirmed rate) is kept as it is.

- **Commission held outside the container** (`services/factory/containerCommissionJournal.ts`):
  - Commission on a container's raw-stock row (`factory_raw_stock.commission_*`, written by an opening-balance entry) now posts `FACTORY-COMM-{container}` when the container carries no commission of its own: same journal, same rules (Dr the container's import cost account, else Factory Import Cost / Cr the payee; normalized). Rate: the row's own stored rate (the table has no "confirmed" flag, so a non-USD rate must be positive and not the unset default 1, as `resolveStoredFxRate` reads it), else the container's confirmed rate for the container's currency. Payee: the row's commission supplier (the "[supplier] Commission" sub-supplier the opening balance creates), else the container's supplier, else the row's commission ledger account. With no rate or payee nothing is posted. An opening-balance container has no import voucher and no receipt, so the debit stays on Factory Import Cost (no stock-journal credit offsets it).
  - Writers, each in its own transaction: opening-balance create (`raw-stock/opening-balance/crud.ts`), edit (when a commission field or the container's supplier, currency or rate changes), delete (removes it); raw-stock receipt delete (`rawStockAdjRoutes.ts`, a soft delete: removes it); restore of a raw-stock row (`admin/deleted-items/restore.ts`, now one transaction: re-posts it); FX resolution of a container rate (`fxResolutionRepair.ts`: a commission in the container's currency posts at the confirmed rate). Offload, reverse offload, container create/update/import/delete and the daybook commission edit already synced (wave 8.4 continuation); the daybook edit's record update is now scoped to the company.
  - No double count: one journal per container. When the container has its own commission, only that is posted; a raw-stock commission beside it is listed for review. An offload commission record (`factory_container_commissions`) is never journalled on its own: the offload copies it onto the container, whose commission the journal posts.
  - Listed, not back-filled: integrity diagnostic `factory_commission_outside_container_journal` (warn) — a raw-stock commission with no journal (legacy, no rate, no payee) or beside the container's own commission, and a commission record its container does not carry (no commission, or another amount or currency). Not-in-ledger memo (`unpostedMemo.ts`, new sources `factoryRawStockCommission`, `factoryCommissionRecord`, translated): those on a container with no commission of its own (a record that only differs from its container's commission is in the diagnostic only, so the memo never lists the same commission twice).
  - Not changed: admin permanent delete of a soft-deleted container (and the factory supplier permanent delete) still keep the container vouchers, as documented in `permanent-delete.ts`.
- **Factory POS void** (`pos-financial/sale-delete.ts`): the void now deletes the sale's `FACTORY_POS_SALE` / `FACTORY_POS_DEPOSIT` rows in `customer_balances` in the void transaction, as an edit does. Before, they stayed and the memo hid them. The memo keeps its rule for sales voided before (their rows stay, unlisted; history is not changed).
- **One supplier rule — the posting company (wave 13 decision 2)**:
  - Unified supplier ledger (`/api/suppliers/:id/unified-ledger`, now `routes/vouchers/unifiedSupplierLedger.ts`): per company read, the lines the engine attributes to the supplier, and the engine's period opening (the opening with its side, only in the supplier's own company, plus owned lines before `startDate`); running balance in Decimal. Its closing equals the engine's. Before: every supplier-tagged line, and the unsided master opening shown only when the viewing company was the parent by the global `parentCompanyId` setting (no brought-forward with a start date). Supplier-partner companies keep every supplier-tagged line (their SP payable evidence, documented design; the SP reconciliation reads the same lines); a line the engine gives to its account carries `spPayableEvidence: true`. **Meaning change:** a supplier's own company now sees its opening there whatever the global setting; a supplier-tagged ledger/bank line of an ordinary company is no longer listed.
  - Historical supplier reference statement (`routes/accounts/historicalSupplierReferenceRoutes.ts`, which serves the non-paginated `/api/accounts/supplier/:id/transactions` ahead of `accountTransactionRoutes.ts`): lists only owned lines (wave 13 said the statement did, but this route shadowed that one and still listed every supplier-tagged line), the brought-forward `preNetBalance` counts the same lines, and the response adds the engine's `openingBalance`, `openingBalanceSide` and `periodOpeningBalance`. The child-PO reference rows are added when the company read has linked children (`companies.parent_company_id`); `isParentCompanyContext` (global setting) is no longer used here.
  - Import-cycle balance (`routes/import-cycle/balance.ts`): the supplier balance is the engine's suppliers of the company (opening with side in the supplier's own company, owned lines, mixed lines netted). Before: gated on the global setting (a company other than the configured parent showed 0), every company's suppliers' openings added unsided, supplier-tagged ledger lines counted again on the supplier, mixed lines dropped.
  - `/api/accounts/all` (`routes/accounts/all.ts`): every supplier the company owns is listed (a child company used to hide its own suppliers with no lines and no opening), plus suppliers of another company it posted to (`postedFromOtherCompany: true`), as on the Suppliers page.
- **Tests:** `tests/wave14-factory-supplier-leftovers.test.ts` (opening-balance commission posted, replaced on edit, removed on delete, foreign rate; legacy row and an uncarried record listed in diagnostic and memo; container commission beside a raw-stock commission posted once; POS void removes the cache rows; unified ledger and historical statement = engine, period opening, the global setting never read; import-cycle and accounts/all on the posting company). Updated: `backend-coverage-phase18-supplier-partner-accounting` (the plain SP supplier's 125 Cr opening now opens its own company's unified ledger; the SP evidence line is still counted and now flagged), `import-cycle-balance-exact` (mocks the engine the supplier balance now reads). `config/float-money-baseline.json` lowered (voucherQueryRoutes 4 → 1).
- **Remaining:** commission and POS rows from before this wave stay listed until edited; the supplier-partner exception of the unified ledger is by design; the client account pickers still compute supplier openings from `/api/accounts/all`.

### Wave 7 leftovers (2026-10-09) — complete in code

Owner decisions 2026-10-09 (binding) for the "Not done" items of wave 7. The inter-company counterpart re-scale and the database balance constraint were already done in 8.5 and are not touched.

- **PO charge and line-item edits, one transaction (item 1):**
  - Charges path of `PATCH /api/purchase-orders/:id` (`routes/containers/containerFreightWriteRoutes.ts`): the PO update (was `storage.updatePurchaseOrder`, autocommit), the voucher and its lines, the own-account `FREIGHT-` voucher, the container totals and `container_charges` (one branch wrote them on the pool), goods in transit (its own transaction), the inter-company counterpart (was on the pool, failures swallowed) and the audit row (was after the response's writes, failure swallowed) now commit in one transaction. It locks the container, then the PO (the offload lifecycle's order); the container totals read the company's POs of that container in the transaction.
  - Items path (`purchaseOrderItemsUpdate.ts`): already transactional; the post-commit "backup" inter-company sync on the pool is removed (the in-transaction sync throws and rolls the edit back), the audit row is written in the transaction (line items now compared by stock item, as new rows get new ids), container totals read in the transaction.
  - `PATCH /api/vouchers/:id/purchase` (`routes/vouchers/voucherPurchaseUpdateRoutes.ts`): line items, PO, container, voucher, goods in transit and audit were separate autocommit writes and the voucher's lines were never changed (only its header total, set to the items total although the voucher carries the charges too). Now one transaction under container → PO locks; the goods lines (first purchases debit and first non-freight credit) move by the items difference, freight lines untouched, the header total is the debit side; a voucher with lines but no goods line is refused (409). A line-less voucher keeps its old header behaviour.
  - `POST /api/po-import/backfill`: the PO's voucher link commits with the voucher.
  - A closed period now rolls the whole edit back (the PO no longer changes while its voucher is refused).
- **Factory container create, atomic (item 2)** (`routes/factory/containers/create.ts`): the container, its daybook row, `FACTORY-IMPORT-{id}-*`, `FACTORY-FREIGHT-{id}` and `FACTORY-COMM-{id}` (`syncContainerCommissionJournalTx`) commit together (before, only the container and its commission journal shared a transaction). Create writes no stock rows. A freight payer with no credit leg (neither supplier nor own account) is refused instead of posting a one-sided freight journal. Excel import was already one transaction per row.
- **Factory payroll "mark PAID" posts the payment (item 3)** (`routes/factory-payroll/update.ts`, `services/payroll/factoryPayrollPaymentVoucher.ts`): `PATCH /api/factory/payroll/:id` with `status: "PAID"` requires `cashAccountId` (400 without one; a live account of the payroll's company, not Payroll Payable) and posts `PAYMENT-PAY-{payroll}-PAID` Dr Payroll Payable / Cr that account for the net salary, with the posting identity `infra:factory-payroll-payment:{company}:{payroll}:payment`; the payroll row (`paid_at`, `cash_account_id`), the daybook row and the audit row are in the same transaction (the row is locked and its status re-checked). Saying PAID again posts nothing. Un-marking (any other status) removes every `PAYMENT-PAY-{payroll}-*` voucher with its posting identity and the payment daybook row in the same transaction; the undo route uses the same removal (its plain delete would have been blocked by the posting identity) and now writes an audit row. An amount change on a paid payroll is refused (409: un-mark first). Client: the payment dialog asks for the paying cash or bank account (`FactoryPayrollView.tsx`, translated).
- **Factory payroll generation posts the accrual (item 4)** (`services/payroll/factoryPayrollGenerationService.ts`): `POST /api/factory/payroll/generate` rebuilds the period's `PAYROLL-GEN` voucher (Dr salary/bonus expense per worker / Cr Payroll Payable for the net / Cr Factory Worker Advances for deductions — `rebuildPayrollGenVoucher`, as the bulk generator and the edit, delete and undo routes do) in the generation transaction, so generating more workers replaces it; deleting a payroll already rebuilt it without that payroll, and its daybook and audit rows now commit with the delete. Advance settlement in the generator is in Decimal. The payment in item 3 clears the payable.
- **Advance delete (item 5)** (`routes/payroll/advanceManagementRoutes.ts`): `DELETE /api/factory/advances/:id` refuses an advance with any repayment (409 `ADVANCE_HAS_REPAYMENTS`, "Reverse the repayments first, then delete the advance."); before, it deleted the repayment rows and left their `RECEIPT-REPAY-` / `REPAY-SAL-` vouchers crediting Factory Worker Advances. An advance with none is deleted with its `PAYMENT-ADV-{id}-*` voucher, daybook rows and an audit row in one transaction (row locked). The two ways to reverse repayments now take their receipt vouchers with them in the same transaction, audited: `DELETE /api/factory/advance-repayments/:id` (`worker-statement/repayments.ts`; its daybook row also moved into the transaction) and `POST /api/factory/advances/:id/reverse`.
- **Listed, not back-filled** (`services/accounting/integrity/payrollAdvancePostingChecks.ts`, wired into the integrity diagnostic, warn): `factory_payroll_paid_without_payment_voucher` (PAID payrolls with a net salary and no `PAYMENT-PAY` voucher), `factory_payroll_period_without_accrual` (payroll periods with no `PAYROLL-GEN`), `factory_advance_repayment_voucher_orphaned` (receipt vouchers whose repayment is gone). No memo line: the not-in-ledger memo is per customer and factory supplier, and these amounts sit on payroll payable, cash and worker advances, not on a party balance.
- **Tests:** `tests/wave7-leftovers-atomic-posting.test.ts` (charge and item edits commit PO, voucher, container, charges and audit together, balanced, and roll back whole in a closed period; purchase-voucher edit keeps the voucher balanced; container create posts three balanced journals and rolls back container, daybook and journals on a refused freight journal; PAID refused without or with a foreign account, posted once Dr payable / Cr cash, a paid amount change refused, un-mark removes it, a closed period rolls the status back; generation posts a balanced accrual once and a delete rebuilds it, audited; advance with a repayment refused, repayment reversal removes its voucher, advance without one deleted with its voucher, closed period keeps it; the diagnostic lists the three pre-wave cases). Updated: `factory-worker-advance-write-routes` (decision 5), `factory-payroll-edit-exact`, `factory-payroll-generation-service`, `phase33-3c-purchase-order-items-update`, `purchase-order-charge-edit-exact` (harnesses for the row locks and in-transaction audit), `write-route-guard-sweep` (the three factory payroll routes now post through the service, so they moved to the delegated list; `DELETE /api/factory/advance-repayments/:id` is sensitive now).
- **Remaining:** `PATCH /api/factory/payrolls/:id/mark-paid` and the bulk route still number their vouchers `PAYMENT-PAY-{id}-{timestamp}` and do not refuse an already-paid payroll (outside this wave's decision); the items path of the PO edit still sets every debit and credit line of the PO voucher to one total (a voucher with embedded freight lines is rebuilt only by the charges path); `POST /api/factory/payrolls/generate-bulk` writes its `PAYROLL-GEN` from the batch's workers only, not the period's; a payroll-deduction repayment deleted through the repayment route is not reflected in the payroll that deducted it.

### Wave 15 (A) — perpetual readiness tooling (2026-10-09) — complete in code

Owner decisions 1 and 2 of the wave 15 plan (binding); section 8 items C1, M1 and M3, and the readiness report. Nothing changes stored data except the reviewed apply below; production was not touched.

- **Readiness resolution (decisions 1–2)** (`services/inventory/inventoryReadinessResolution.ts`, `routes/accounting-integrity/perpetualReadinessRoutes.ts`).
  - `GET /api/accounting/perpetual-inventory/readiness-resolution` (Admin/Owner, read-only): per company the stock on locations whose row no longer exists, grouped by missing location id (rows, items, quantity, value; `sharedWithOtherCompanies` when another company's rows use the same id), and the anomalous rows on the company's non-deleted locations, bale mirror left out (the predicates `stockValuation` reports): `VALUE_AT_ZERO_QUANTITY`, `POSITIVE_VALUE_ON_SHORT_ROW` (negative stock holds its provisional value as a negative value; a positive one is wrong), `NEGATIVE_VALUE_ON_STOCK`. Anomalous rows on a missing location are flagged in its rows. Totals and a sha256 `planHash`.
  - `POST .../readiness-resolution/apply` (Owner; `{ confirm: true, planHash, actions: [{ locationId, action: "restore" | "writeOff" }], writeOffAnomalies }`): one transaction, company scope asserted, advisory lock, refused in a closed period (today), plan recomputed and applied only when the hash matches (409 `PLAN_CHANGED`); an action on an id outside the plan or repeated is 400, a shared id 409.
    - `restore`: the location is recreated with its id (explicit insert, then the `locations_id_seq` sequence is moved past the largest id) as an inactive location of the company, code `ARCHIVED-LOC-{id}` (with `-{company}` if that code is taken), name "Archived location #{id}". The valuation counts inactive locations, so the stock is counted again; no row changes.
    - `writeOff`: the location is recreated the same way (the canonical movement journal references locations), each row goes to zero quantity and value through `reverseInventoryByExactValue`, the row's shortage layers are removed, and a canonical movement (`inventory_readiness_write_off`) is written per row that moved quantity.
    - `writeOffAnomalies`: each anomalous value goes to zero, the quantity is kept (the count is physical, the value is the anomaly); anomalous rows of a location restored in the same apply are included.
    - **Ledger side (decided):** before the company's cut-over the ledger holds no inventory and orphaned stock is in no valuation, so a restore or write-off of it posts and evidences nothing (the opening, valued as of the eve, then sees the restored stock and not the written-off stock). An anomaly write-off changes the sub-ledger total, so it records its dated evidence (below) and, once the cut-over applies, posts `INV-MOVE-…-readiness-anomaly-…` to INVENTORY_ADJUSTMENT. After the cut-over, orphaned stock can only come from a location removed after it (the apply guard below), so the ledger holds it: a restore posts nothing; a write-off posts `INV-MOVE-…-readiness-write-off-…` to INVENTORY_ADJUSTMENT.
    - One audit row in the transaction (`inventory`, `inventory-readiness-resolution:{run}`): the recreated locations (old: missing; new: code, name, inactive, action), the restored rows, every written-off row and anomaly before and after, the journals.
  - Note: the startup migration stage `005-orphan-fk-repairs.ts` archives and deletes orphaned inventory rows when startup migrations run; production runs with `RUN_STARTUP_MIGRATIONS=false`, so its orphaned stock is still there — resolve it with this tool before startup migrations are ever enabled there.
- **Cut-over apply guards (decision 2, M3)** (`perpetualInventory/openingJournal.ts`). The apply is refused (409) while, for a company that is not a supplier partner, any orphaned-location stock or anomalous value remains (`READINESS_BLOCKERS`, the message gives rows, values and locations), and while anything is dated on or after the cut-over date: vouchers (as before), offloads (container offload date, else the offload's own date), factory container receipts (not deleted), and evidenced stock movements (`DOCUMENTS_ON_OR_AFTER_CUTOVER`, the message gives each count). These messages now carry counts, so they are not in the translation tables (the readiness report shows the same figures). Consequence: the readiness resolution must be applied before the cut-over date (its evidence is dated the day it runs). The opening plan lists the POs its Goods in Transit line carries (`goodsInTransitPurchaseOrderIds`).
- **Containers offloaded before the cut-over (C1)** (`perpetualInventory/stockReceipts.ts` `postPreCutoverOffloadMovementTx`, wired in `offload-lifecycle/execute.ts`, `reverse.ts`, `charge-voucher-sync.ts`, `routes/containers/offload/recalc.ts`, `offloadOptionalToggle.ts`). The opening carried such a container's stock in Inventory and left its PO cost in Purchases; no STOCK-IN exists for it. Once the cut-over applies, the measured sub-ledger change (the inventory helpers' `valueDelta`) is journalled, dated the day of the change:
  - reverse, and a suspend that leaves the container OTW: `INV-MOVE-…-offload-to-transit-{container}:…` Dr Goods in Transit / Cr Inventory for the container's PO purchase cost (the reconciliation then counts those POs in transit), and `INV-MOVE-…-offload-precutover-{container}:…` for the rest against Purchases;
  - restore of a suspended offload dated before the cut-over: Cr Goods in Transit for what the ledger holds in transit for the container (opening-listed POs plus earlier transit journals), the rest against Purchases;
  - replace keeping a date before the cut-over, charge re-pricing, and a suspend that leaves another offload active: the change against Purchases (where the periodic book carried the cost). A replace onto a date on or after the cut-over journals only the reversal of the old receipt; STOCK-IN takes the new one.
  - refused (409 `CONTAINER_OFFLOAD_BEFORE_CUTOVER`, translated): any other offload dated before an applied cut-over (a new offload, or an edit of an offload dated on or after it), since nothing could carry its ledger side.
  - **carriedByOpening** now tests the offload date: a PO is carried by the opening as goods in transit only when the applied plan lists it (dated before the cut-over and its container not offloaded by then). STOCK-IN adds what the container's transit journals left in Goods in Transit. A plan applied before the list existed falls back to the PO date, unless a pre-cut-over transit journal exists for the container. Before: a PO dated before the cut-over was always credited from Goods in Transit, so a container offloaded before the cut-over and later re-offloaded credited Goods in Transit the opening never debited.
  - Not covered: cost corrections entered on the edit of a pre-cut-over offload keep their own INV-MOVE dated with the offload (wave 15 B owns that path), so after the cut-over they post nothing; listed by the reconciliation.
- **As-of replay completeness (M1)** (`routes/helpers/inventoryHistoryHelpers.ts`, `inventory/stockValuation.ts`, `perpetualInventory/inventoryMovementJournal.ts`). Approach chosen: canonical stock movements are not complete (only some writers record them, they carry no value-only change — `quantity_delta <> 0` — and none for direct row rewrites), so the replay was extended instead.
  - Every `postInventoryMovementJournalTx` call (quick adjust, archive/restore, location imports after the cut-over, offload cost corrections, silent production/transfer, transfer and reversal residuals, readiness write-offs, C1 journals) now records its lines, dated with the movement, in `inventory_value_movements` — before and after the cut-over, journal or not, replaced whole with its source like the journal. Lines carry the item, location, signed value and, where known, quantity (`inventoryMovementLine` derives it; archive/restore pass it). The table is declared in `shared/schema/erp/vouchers.ts` and created at boot by `ensureInventoryCutoverSchema` (no foreign keys, non-fatal like the cut-over table).
  - `calculateHistoricalLocationInventory` reverses the evidenced item lines after the date; `companyStockValuationAsOf` reverses the item-less lines (transfer/reversal residuals, C1 journals) from `subLedgerTotal` (`excluded.unitemizedMovementValue`).
  - Date basis: document lines (sales, adjustments, transfers, credit/debit notes) are replayed by `COALESCE(effective_date, voucher_date)`, the ledger's basis; offloads by the container's offload date, else the offload's date (STOCK-IN's date; it was the offload timestamp). Credit and debit notes that are optional are no longer replayed.
  - Remaining: writers that rewrite inventory rows without an INV-MOVE (stock merge, inventory rebuild/value repairs, item permanent delete, SP migration) leave no evidence, so the as-of replay misses them and the reconciliation shows them; movements before this deployment have no evidence. A sale's COGS journal is dated with the sale's voucher date, so a sale with a different effective date differs between the two sides on the days between.
- **Readiness report (item 5)** (`perpetualInventory/readiness.ts`, `GET /api/accounting/perpetual-inventory/readiness`, Admin/Owner, `?effectiveFrom=`). Read-only, one repeatable-read snapshot per company: orphaned stock and anomalies, unvalued factory raw/bale rows, open mixes without a USD rate, unposted factory invoices, legacy factory FX lines unrepaired and without a dated rate (wave 6 plan), documents dated on or after the planned cut-over, the opening plan summary, the cut-over state and posting switch, and (once applied) the reconciliation; `blockers` (code, count, value, message) and `ready`. It is section 9's checklist, runnable after deployment.
- **Tests:** `tests/wave15-readiness.test.ts` (as-of reconciliation of a past date equals the ledger across a quick adjust, an archive and its restore; preview lists orphans and anomalies, plan-hash mismatch 409, restore counts the stock at an inactive archived location, write-off zeroes rows with canonical evidence and audit, anomaly evidence; cut-over apply refused by orphaned stock and by a factory receipt dated on the cut-over, applied after; readiness blockers; C1 reverse journals, re-offload credits transit once, an edit onto a later date credits Purchases, an opening-listed PO credits Goods in Transit, an offload dated before an applied cut-over refused). Updated (pinned replaced behaviour): `wave11-valuation` (the as-of replay used the voucher date and showed a −10.00 difference between voucher and effective date; both sides now use the effective date).

### Wave 15 (B) — stock path gaps (2026-10-09) — complete in code

Re-audit section 8 inventory items C2, H1–H3, M5, M7–M10 and the wave 11 follow-up leftovers (except raw-stock receipt tagging and the raw-material ADD/REMOVE valuation, which belong to the factory raw-stock writers).

- **C2, restoring a deleted stock document** (`services/inventory/voucherStockReversal.ts` `isUnrestorableStockDocumentTx`, `admin/deleted-items/restore.ts`). Choice: **refuse** (the safer option). Deleting a stock document moves its stock back exactly and deletes its rows; restoring the voucher alone put its ledger lines back with no stock and no COGS. A transfer or stock adjustment voucher without its header row, and a sale or credit/debit note with no lines whose delete left canonical reversal movements (`*voucher_delete_pos_sale|credit_note|debit_note|stock_transfer|stock_adjustment`), is refused with 409 `STOCK_DOCUMENT_NOT_RESTORABLE` (translated); the user re-enters the document. Keeping the rows on delete and replaying them was rejected: every stock reader would have to skip a deleted voucher's rows, and a replay at today's cost is not the original movement. Not detected: a sale or note deleted before the canonical journal existed (no evidence left).
- **H1, transfer revision approvals** (`stockTransferRevisionLifecycle.ts`, `immutableStockTransferRevisionLifecycle.ts`, helper `applyTransferRevisionDeltaTx` in `conservedStockTransfer.ts`): an increase moves the extra quantity through `moveTransferLegConservedTx` (the destination receives what the source relieved); a decrease moves back the line's share of its value moved (value × returned ÷ old quantity, the whole value when the line goes to zero) through `reverseTransferLegExactTx`. The line keeps `value_moved`, the net of the legs is posted by `postTransferResidualTx` (INV-MOVE vs COGS, a no-op before the cut-over), and a bale-mirror item is refused after the cut-over. Both used to issue and receive at the line's 2dp rate (or the source's average for a new line), so value was created or lost and a later delete reversed the wrong amount. The pending lifecycle now also journals its legs in the canonical stock journal (it left the write-evidence backlog: ceiling 16 → 15).
- **H2, stock transfer imports** (`routes/stockTransferImportRoutes.ts`, new `routes/stockTransferImportPosting.ts`): both imports move each line conserved, record `value_moved`, post the residual, mark the transfer `inventory_applied` (it stayed false, so a later edit treated the posted transfer as never applied and moved it again), refuse a bale-mirror item after the cut-over, and after the cut-over refuse a line whose source has no inventory row (409 `STOCK_TRANSFER_IMPORT_SOURCE_MISSING`, translated: the fallback cost was the item's selling price). The single-source import now has `requireNonPOS` and reads the source rate in the company from the header source (it read any company's row, at the item's own source). Example: 3 units worth 10.00 (average 3.3333333) used to arrive as 9.99; they arrive as 10.00.
- **H3, missing-source transfer** (`storage/stock-ops/transfers-create.ts`): the short source keeps the negative value of the shortage (negative-stock policy), exactly what the destination received. It was reset to 0 after the move, which created the destination's value from nothing (4 × 12.34: +49.36 with no journal).
- **M5, re-dating a sale** (`perpetualInventory/saleCogs.ts` `redateSaleCogsTx`/`assertSaleRedateAllowed`; `PATCH /api/vouchers/:id`, `PUT /api/vouchers/:id/with-entries`): `COGS-{id}` takes the sale's new date in the same transaction (in place: same lines, same identity). A sale with stock lines cannot be moved across the company's cut-over date (409 `SALE_DATE_CROSSES_INVENTORY_CUTOVER`, translated): before it the opening journal holds the sale's stock effect, after it the COGS journal does. The with-entries route checks before its separate location-move transaction. Factory POS is not covered here.
- **M7** (`services/factory/baleCostBasis.ts` `containerUsdRate`): the container's USD cost per kg is read from its live raw-stock rows only, received-kg weighted when the rows differ; it took the first row by id, soft-deleted or without a USD cost.
- **M8** (`perpetualInventory/factoryValuation.ts`): legacy closed order statuses (DISPATCHED, SOLD, INVOICED, COMPLETED) count like FINALIZED — an IN_STOCK bale on such an order is not stock, a SOLD bale on one is not "sold, not invoiced"; open orders are DRAFT, LOADING, PENDING_VERIFICATION, VERIFIED (DRAFT added to the reserved count). Constants `INVOICED_ORDER_STATUSES`, `OPEN_ORDER_STATUSES`.
- **M9, merge / purge / permanent delete** (`routes/stock/merge/repointDocumentLines.ts`, `services/inventory/stockItemHistory.ts`). Choice: a merge **repoints** the duplicate's stock document lines (sales, adjustment, transfer, revision, credit-note, offload, waste-dispatch and group-archive lines) and its shortage layers to the kept item, in the merge transaction, and records the repointed ids in the merge log (`snapshotAfter.repointedLines`); amounts are untouched. A reversal then lands on the row that holds the merged stock (it used to recreate stock on the merged item while the kept item kept it). Unmerge puts those lines back and is refused after the cut-over (it rewrites inventory from a snapshot with no journal). The canonical stock journal and valuation records stay on the merged item as evidence, so a merged item is never purged or permanently deleted: the permanent delete refuses any item named on a stock document, movement, shortage layer or valuation record, or holding stock (409, translated; otherwise one transaction, audited), and the 30-day purge keeps such items (it deleted their document lines).
- **M10** (`offload-lifecycle/execute.ts`, cost-correction branch only; both offload routes pass the session role): an inventory cost correction needs Admin or Owner (Developer passes) — 403 `CONTAINER_OFFLOAD_COST_CORRECTION_FORBIDDEN` (translated), nothing written. The offload itself keeps its access.
- **Wave 11 leftovers:**
  - stock adjustment into short stock (`perpetualInventory/stockAdjustments.ts`): the receipt lines' settlement variance (`total_amount − value_moved`) is posted to COGS on its own marked line (owner decision 2); only the rest of the difference stays on INVENTORY_ADJUSTMENT. Example: short −2 at 3.00, produce 2 at 5.00 → Cr Stock Adjustment 10.00, Dr Inventory 6.00, Dr COGS 4.00 (was Dr Inventory Adjustment 4.00);
  - bale mirror: the sale create paths (`POST /api/pos/sales`, POS edit) already refused; the gap was activation. Activating a suspended sale or transfer (`PATCH /api/vouchers/:id/optional`, and `PATCH /api/vouchers/:id` with `optional`) refuses a bale-mirror item after the cut-over. `PATCH /api/vouchers/:id` now toggles through the same value-exact toggle as the optional route (`optionalInventoryEvidence.ts`): it used to move stock its pre-wave-11 way (transfers at 2dp rates, sales with no COGS journal, debit notes received like credit notes);
  - waste dispatch create (`stockAdjustmentWasteRoutes.ts`): voucher, adjustment and dispatch rows in one transaction (`createStockAdjustmentWithVoucherTx`); a failed adjustment used to leave the Consumption voucher behind. Its delete is unchanged (storage delete, then the dispatch rows).
- **Tests:** `tests/wave15-stock-paths.test.ts` (one fixture per item). Updated: `legacy-stock-transfer-missing-source` (the short source now holds −49.36, not 0: that 0 was the created value), `backend-wave4-deleted-items-permanent` (an item still holding stock is refused; the delete is shown with an empty stock row).
- **Remaining:** the waste dispatch delete runs in two transactions; the single-source import's parse/validate previews have no `requireNonPOS`; legacy deletes without canonical evidence are restorable as before; the raw-material ADD/REMOVE valuation and raw-stock receipt tagging are with the factory raw-stock writers.

## 7. Re-audit (2026-10-07, branch `claude/erp-accounting-audit-27nl3e` at `d151801`)

Method: three independent read-only reviews of the code on the branch (posting and integrity; inventory and factory; chart of accounts, AR/AP, currency, multi-company and reporting). They verified the wave log against the code rather than taking it as given, and ran the targeted tests. The production database could not be queried: its IP allowlist is empty, so the 2026-10-06 production figures are the latest. **Production runs `main` (`9f2e4ce`); nothing on this branch is deployed.**

### Score

| Category | Before (2026-10-06) | Branch code (2026-10-07) |
|---|---|---|
| Chart of Accounts | 20 | 40 |
| Double Entry | 35 | 35 |
| General Ledger | 25 | 40 |
| Posting Engine | 40 | 40 |
| AR/AP | 30 | 25 |
| Inventory | 15 | 36 |
| Factory Accounting | 15 | 30 |
| Multi-Currency | 40 | 28 |
| Multi-Company | 55 | 45 |
| Reporting | 10 | 22 |
| Data Integrity | 30 | 45 |
| Audit Trail | 40 | 28 |

**ACCOUNTING SCORE — branch code: 35/100. Production as deployed: unchanged at 28/100** (and lower under this re-audit's stricter reading, since its new findings also apply to `main`).

The categories that fell did not regress. The re-audit found defects that already existed and that the first audit missed: the automatic FX revaluation, more balance engines, and gaps in the audit trail. The real gains are the removed plugs, the trial balance and diagnostic, the database guards, the account registry, the fiscal close, normalized factory FX writers and atomic writers. The perpetual-inventory build (wave 8) is off, so it does not yet change the books.

### Wave-log claims corrected by the re-audit

- **Wave 2:** the validated `PATCH /api/voucher-entries/:id` in `voucher-entries/write.ts` never runs. `voucherEntryCurrencyEditRoutes.ts` registers the same path first (`registerLedgerRoutes` comes before `registerVoucherEntryRoutes`) and edits a line with no balance check.
- **Wave 8.5:** the voucher balance guard applies only from a company's cut-over, and no cut-over can be applied while the switch is off. **Today the database enforces balance for no company.**
- **Wave 8:** the reconciliation and the opening plan value stock as quantity × average rate, while every posting moves `total_value`. Negative stock makes sale COGS smaller than the stock later received. Once switched on, the ledger would not reconcile to the sub-ledger from the first negative-stock cycle.

### Remaining defects that matter most

CRITICAL:
1. `POST /api/exchange-rates` (any signed-in user, including POS) posts an automatic revaluation on every rate save. It treats every Cash account as CFA, uses float maths and autocommit writes, posts again when the same rate is re-saved, and writes no audit (`exchangeRateRoutes.ts:91-321`).
2. Active vouchers can still be committed unbalanced:
   - the live voucher-line PATCH;
   - `PATCH /api/vouchers/:id/optional` and `POST /api/vouchers/:id/finalize` activate optional vouchers without a balance check;
   - `PUT /with-entries` lets the client change the voucher type to an exempt one.
3. `/api/reports/balance-sheet` (`financialReportsService.ts`) is wrong in several independent ways: it has no optional/deleted filter, ignores opening sides, recognises only three types, has no customers or factory suppliers, and has no current-year earnings line.
4. Destructive admin routes have no audit and no transaction:
   - company data reset, permanent delete, voucher restore;
   - the intercompany counterpart hard-delete;
   - company delete, which also removes `audit_log`.
5. Inventory paths outside the perpetual design move stock with no ledger counterpart: quick adjust, silent imports, closing-stock transfer, cost corrections, repair and rebuild tools.

HIGH:
- Factory POS sales post at rate 1 and leave credit revenue out of the GL.
- Factory FX rates ignore the transaction date.
- The currency normalization trigger has no installer in code.
- The net-profit Excel divides cash by the CFA rate and uses undated stock.
- Indirect Income is classified as a liability.
- At least six net-position engines and more than ten receivable engines disagree.
- Opening balances are still on master rows and can be edited after a close.
- Factory bale cost mixes native-currency and catalogue prices, so finished goods and COGS would be in mixed units.
- About 109 writer files write no audit.
- Edits overwrite lines in place, and their audit is written after commit.

### Before the perpetual switch, and next waves

- **Wave 9, ledger safety:** fix the five CRITICAL items above, starting with the FX revaluation and the unbalanced-activation paths. Extend the balance guard to every company for vouchers created after its install date, so legacy rows stay untouched.
- **Wave 10, one balance engine:** a single receivable and payable engine shared by statements, pages, net position and the trial balance; fix the balance sheet and Indirect Income.
- **Wave 11, inventory fidelity:**
  - value stock by `total_value` everywhere;
  - post the remaining inventory paths;
  - make reversals value-exact;
  - fix the factory bale cost basis.
  - Then re-run the reconciliation on production data before setting `PERPETUAL_INVENTORY_POSTING_READY = true`.
- **Wave 12, audit trail:** write audit in the posting transaction, and use reversal entries instead of in-place edits for posted vouchers.

## 8. Re-audit (2026-10-08, branch at `ac33c40`, after waves 9–11)

Method: four independent read-only reviews. Three reviewed the code at `ac33c40` against the wave log rather than taking it as given (posting and integrity; inventory and factory; chart of accounts, AR/AP, currency, multi-company and reporting). The fourth measured production read-only, one company scope per query (the database accepted scoped queries again). **Production runs `b99706a`, deployed by hand on 2026-10-08 from a branch that is not on `main`; nothing on this branch is deployed. `PERPETUAL_INVENTORY_POSTING_READY` is still false, so no company is on perpetual inventory and the general ledger is still a periodic book.**

### Score

| Category | Before (2026-10-06) | Re-audit 1 (2026-10-07) | Now (branch code) |
|---|---|---|---|
| Chart of Accounts | 20 | 40 | 45 |
| Double Entry | 35 | 35 | 46 |
| General Ledger | 25 | 40 | 45 |
| Posting Engine | 40 | 40 | 45 |
| AR/AP | 30 | 25 | 40 |
| Inventory | 15 | 36 | 50 |
| Factory Accounting | 15 | 30 | 42 |
| Multi-Currency | 40 | 28 | 35 |
| Multi-Company | 55 | 45 | 48 |
| Reporting | 10 | 22 | 33 |
| Data Integrity | 30 | 45 | 48 |
| Audit Trail | 40 | 28 | 32 |

**ACCOUNTING SCORE — branch code: 42/100** (35 at re-audit 1). **Production as deployed: about 28/100, unchanged** — production has none of the branch's guards (see below).

Gains verified in code: one balance engine behind the trial balance, balance sheet, customer pages and every engine-based net position; one account classifier; banks in net position; automatic FX revaluation removed; balance guard for every company; destructive admin routes transactional and audited; stock valued by `total_value` with a sound negative-stock model and value-exact reversals; factory bales costed at USD material cost with the variance split. Inventory and factory scores are for the code: with the switch off, waves 8 and 11 do not yet change the books.

### Production measurements (2026-10-08)

- **No guard is installed.** The two balance-guard triggers, `gl_inventory_cutovers` and `voucher_balance_guard_since` are absent. `voucher_entries` has no foreign key to `ledger_account_id` or `bank_account_id` and no CHECK constraints. Present: closed-period guards, currency normalization trigger, company-sync triggers.
- **The plug writer is still live.** `equity_adjustment_*` was rewritten on 10-07/10-08 for companies 1 (−6.55M), 8 (−575,647), 10 (−73,901) and 9 (+5,143); 12 (−26.8M) and 13 (+1.54M) are unchanged since the summer. The plugs come from the import-cycle formula and do not equal any ledger difference.
- **Trial balance.** No unbalanced non-stock voucher exists. All 177 unbalanced active vouchers are Mixed, Production or Consumption (26 created in the last 30 days, 2 on 10-08). Company 1's Mixed vouchers have two lines and still do not balance, so they are errors, not one-sided stock entries. The large differences are master opening balances: −8.08M (1), +6.03M (13), −505k (10), +113k (8), −43k (17). Customer openings are duplicated on their linked ledger accounts in companies 1, 8, 9 and 10 (546k in 1 and 8). 532 vouchers have no lines.
- **Automatic FX revaluation still posts** in company 9 (9 `FX-REVAL-*` vouchers, about 3,493, latest 10-05).
- **References.** 8 lines from company 1 into company 13 accounts (Dr 1.66M) and 4 lines from company 8 onto company 1 suppliers; 17 lines to hard-deleted accounts, 149 to soft-deleted accounts (company 10), 14 with no target.
- **Inventory.** 21.4M of stock value sits at 66 locations that no longer exist (87% of company 1's stock value; company 8 holds 1.29M there). 871 rows hold value at zero quantity. `total_value` runs about 800k above qty × rate in company 1.
- **Factory.** All 39,479 bales lack a mix or pressing batch link; 36,251 are costed at the catalogue price (about 40× material cost). Company 12 stock of 49.5M has no ledger counterpart. The wave 6 legacy FX repair has not run: 462 EUR/AUD lines (713k EUR, 327k AUD per side) still carry native amounts in the USD columns, and 240 of them have no usable rate. 2 factory vouchers are dated in the future.
- **Account types.** Mis-cased types remain (`EXPENSE`, `LIABILITY`, `EQUITY`); no equity or retained-earnings account in companies 7, 8, 9, 13 and 17. No live account is typed Government Taxes or carries an Indirect Income balance.

### Wave-log claims corrected by this re-audit

- Wave 8.5 "every voucher writer posts in one transaction": false — salary advances (`employees/salaryAdvanceRoutes.ts`) and the rental auto-transfer (`rental/shared/auto-transfer.ts`) autocommit; purchase update, factory container create and waste dispatch commit the voucher apart from its side effects.
- Wave 9 "every active voucher created after the install must balance": overstated — the exemption follows the voucher type label, which the client sets; "created after" relies on `created_at`, which the company import can backdate; single-currency vouchers are checked in the transaction currency only.
- Wave 9 balance sheet "every account type": Government Taxes is treated as a liability and Profit as current earnings, against the classifier and the P&L.
- Wave 5 fiscal close: an income or expense account with an opening balance is closed twice (the closing line includes the opening and the opening is also zeroed).
- Wave 10 "the part-1 customer rule is retired" and "the classifier is used everywhere": the Customers-page and POS-customer statements still use the old rule; the dashboard, ratios, net-profit statement and chat phase 2/3 still match types by exact name; the net-profit Excel still has its own net position (dividing cash by the CFA rate).
- Wave 11 "every reader values by total_value", "reconciles as of any date" and "transfers conserve value": the closing-stock summary still uses qty × rate; the as-of replay misses movements that leave no document line; transfer revision approvals, the transfer import and the missing-source transfer do not conserve value; the bale-mirror refusal was not done.

### Remaining defects that matter most

CRITICAL:
1. Exempt stock types are chosen by the client: a "Production" voucher with one line Dr Cash 1,000,000 passes the application and the database (`voucher-entries/write.ts`, `voucherBalanceGuard.ts`). Production's two-line unbalanced Mixed vouchers are the same hole.
2. Company delete (`storage/auth.ts`, `DELETE /api/companies/:id`): no transaction, removes fiscal closures first, hard-deletes every voucher, deletes `audit_log`, writes no audit.
3. Factory POS posts in the sale currency at rate 1, and a credit sale's revenue is only its deposit while cost of sales is the full sale (`pos-financial/sale-write.ts`).
4. Balance sheet classification contradicts the P&L (`financialReportsService.ts`).
5. Before the switch: stock movements on containers offloaded before a cut-over (reverse, replace, suspend/restore, charge re-pricing) and restored stock documents move the sub-ledger with no ledger counterpart.

HIGH:
- Fiscal close double-counts P&L openings; opening balances stay editable after a close and `POST /api/ledger-accounts/zero-balances` is unaudited.
- About 70 writer files still insert vouchers directly; most audit is written after commit; posted lines are rewritten in place; `audit_log` is not append-only.
- Orphaned-POS permanent delete is open to any non-POS user, unaudited; employee/customer permanent delete clears the party on posted lines.
- ERP supplier pages and factory supplier pages are still separate payable engines; two customer statements and two chat/alert receivable readers too; the AI context lists other companies' suppliers.
- Engine defaults a sideless ledger opening to Dr regardless of type; reports disagree on the date basis (`voucher_date` vs effective date) and on supplier inclusion; group elimination is by name and unpaired.
- Currency normalization trigger still has no installer; the factory FX lookup ignores the transaction date; `POST /api/exchange-rates` is open to any signed-in user and unaudited.
- Factory daily journal credits expense accounts for commission and legacy containers that were never journalled; stock-entry bales without a mix raise finished goods with no material leaving.

### Proposed next waves

- **Wave 12, ledger integrity and audit trail:** stock exemption only for one-sided vouchers written by the stock-document writers (application and database), history marked by an immutable flag, base columns always checked; safe company delete; fiscal-close fix and openings under the period lock; append-only audit written in the posting transaction; reversal instead of in-place edits; guard installers fatal and listed in the diagnostic.
- **Wave 13, reports and payables on the engine:** balance sheet on the classifier; one date basis for P&L, income statement, fiscal close, dashboard, ratios and chat; net-profit Excel on `calculateNetPositionAsOf`; ERP and factory supplier pages on the engine with memo lines; paired group elimination.
- **Wave 14, factory and currency completeness:** factory POS at a confirmed rate with full credit-sale revenue; commission and legacy container payables journalled; date-aware factory FX; normalization trigger installer; exchange-rate route restricted and audited; reviewed run of the wave 6 FX repair.
- **Wave 15, perpetual readiness:** close the before-cut-over container and voucher-restore gaps, conserve value on every transfer path, bale-mirror refusals, complete the as-of replay; on production, decide the orphaned-location stock (21.4M) and zero-quantity values, run the reviewed bale re-cost, then the opening plan and reconciliation — only then consider setting `PERPETUAL_INVENTORY_POSTING_READY = true`.
- **Deployment, independent of the waves:** none of waves 1–11 run in production. The live plug writer and automatic FX revaluation stop only when this branch (or its wave 1 and wave 9 parts) is merged and deployed.

## 9. Production readiness for the perpetual cut-over (read-only, 2026-10-09)

Measured read-only, one company scope per query, aggregates only. Production runs a build without this branch's waves, so these figures are the starting point. `gl_inventory_cutovers` does not exist in production yet (the branch creates it at boot).

### Blockers by company

| Company | Blocker | Figure | Resolved by |
|---|---|---|---|
| 1 COMP001 | Stock at 66 location ids that no longer exist (55 offloads still point at them) | 13,493 rows, 20,109,842.66 | Readiness resolution tool (restore as archived, or write off) |
| 1 | Value at zero quantity | 877 rows, 374,329.67 | Same tool |
| 8 HMDKIN | Stock at 5 missing location ids (nothing references them) | 939 rows, 1,288,190.03 | Same tool |
| 8 | Value at zero quantity | 20 rows, 1,056.88 | Same tool |
| 9 MALI | Value at zero quantity | 1 row, 75.34 | Same tool |
| 17 JNAH | Value at zero quantity | 2 rows, 111.93 | Same tool |
| 12 HMDINTT (factory) | Finished goods at catalogue price × kg, no bale linked to a mix | about 9.99M (4,889 held + 3,127 sold not invoiced) | Reviewed bale re-cost (preview, then Owner apply) |
| 12 | Legacy EUR/AUD lines (native amount in USD columns) | 462 lines; 112 have a dated factory rate on or before their voucher date, 350 do not | Wave 6 repair with dated rates — **dated EUR/AUD rates back to February 2026 must be entered first** |
| 12 | Vouchers dated in the future | 2 EUR journals (2026-10-13) | Re-date, or set the cut-over after them |
| All | Plug writer and missing guards still live | equity_adjustment_* rewritten 2026-10-08/09 (company 1: −6,375,220.83) | Deploying this branch |

No company has negative-quantity or negative-value rows, and no stock voucher lacks its stock document.

### Warnings

- Two-sided unbalanced Mixed vouchers (history, cannot be re-saved without balancing): company 1: 94, 8: 26, 9: 8, 17: 2. One-sided stock vouchers: 1: 22, 8: 6, 9: 5.
- Duplicated customer openings on linked ledger accounts: 1: 493,972.42 (3), 8: 52,230 (1), 9: 384.26 (1), 10: 4,400 (1).
- Lines to another company's or hard-deleted accounts: company 1: 8 into company 13 accounts, 11 to hard-deleted accounts; company 8: 4 (account 918); company 12: 2, plus 13 with no target.
- Vouchers with no lines: 1: 434, 8: 50, 10: 32, 9: 17, 12: 3.
- Company 1: 201 items with unit "BL" share codes with the factory catalogue but are not bale-mirror items (the predicate needs unit BALE) — ordinary stock.
- Company 1: 55 POs with no voucher (2,217,099.10), all on offloaded containers.
- Company 9: automatic FX revaluation still posting (8 active vouchers, latest 2026-09-16) until the branch is deployed.
- Company 12: 48 containers carry 45,500 USD commission with no FACTORY-COMM journal (legacy, listed only); 39 containers have no FACTORY-IMPORT journal; 5 PENDING containers.
- No closed fiscal periods in any company.

### Opening figures today (before any resolution)

| Company | Inventory (non-deleted locations, total_value) | Goods in transit (POs before 2026-11-01, container not offloaded) |
|---|---|---|
| 1 | 2,855,050.33 (about 22.96M if every missing location is restored) | 3,982,413.39 (89 POs) |
| 8 | 480,101.06 | 1,132,160.92 (22) |
| 9 | 124,120.98 | 487,466.37 (12) |
| 17 | 125,091.11 | 0 |
| 7 | 1,930.51 | 143,941.88 (3) |
| 19 | 0 | 114,430.58 (3) |
| 12 factory | Raw material 654,451.34; WIP 89,611.05 (27 open mixes, all with USD rates); finished goods about 9.99M before re-cost | — |

Company 10 (supplier partner) and 13 (properties) have no perpetual stock cut-over.

### Order of operations before turning the switch on

1. Merge and deploy the branch (stops the plug writer and FX revaluation; installs the guards and the cut-over table).
2. Factory: enter dated EUR/AUD rates back to February 2026; run the wave 6 repair plan, review, apply; run the bale re-cost preview, review, apply; re-date or account for the two future-dated journals.
3. ERP companies: run the readiness resolution preview per company; choose restore or write-off per missing location; write off anomalous values; apply.
4. Run GET /api/accounting/perpetual-inventory/readiness — no blockers listed.
5. Opening plan per company, review, apply (cut-over date on the first of a month with no later-dated documents).
6. Run the reconciliation; only then set `PERPETUAL_INVENTORY_POSTING_READY = true`.

## 10. Re-audit (2026-10-09, branch working tree after waves 12–15)

Method: as in section 8. Three independent read-only code reviews checked the branch against the wave log rather than taking it as given: posting and integrity; inventory and factory; AR/AP, currency, multi-company and reporting. A fourth measured production read-only, one company scope per query. The wave 7 leftovers were being written during the review and are not scored. The two CRITICAL boot-time rewrites below were confirmed by hand.

**Production now runs `main` at `11a3096`** ("Retail Wave 1: payments, cashier shifts and accounting"), deployed automatically on 2026-10-09. None of this branch is deployed, and `PERPETUAL_INVENTORY_POSTING_READY` is still false.

### Score

| Category | 2026-10-06 | 2026-10-07 | 2026-10-08 | Now (branch code) |
|---|---|---|---|---|
| Chart of Accounts | 20 | 40 | 45 | 50 |
| Double Entry | 35 | 35 | 46 | 60 |
| General Ledger | 25 | 40 | 45 | 50 |
| Posting Engine | 40 | 40 | 45 | 52 |
| AR/AP | 30 | 25 | 40 | 52 |
| Inventory | 15 | 36 | 50 | 58 |
| Factory Accounting | 15 | 30 | 42 | 50 |
| Multi-Currency | 40 | 28 | 35 | 45 |
| Multi-Company | 55 | 45 | 48 | 54 |
| Reporting | 10 | 22 | 33 | 46 |
| Data Integrity | 30 | 45 | 48 | 52 |
| Audit Trail | 40 | 28 | 32 | 42 |

**ACCOUNTING SCORE — branch code: 51/100** (42 on 2026-10-08). **Production as deployed: about 28/100, unchanged.**

Verified gains: the plug writers only read now; the balance guard v3 is a deferred, fatal, cent-exact check for new vouchers; closed-period triggers cover both dates; audit_log is append-only; company delete is safe; fiscal close uses Decimal and the effective date; supplier, customer and factory supplier pages and statements read the one engine; rate saves are Admin/Owner and audited; the currency trigger is installed at boot; stock value is conserved on transfers; the readiness tool and cut-over guards hold; factory POS revenue and receivables and the container commission are in the ledger.

### CRITICAL

1. **A boot-time history rewrite is still live (wave 1 claim wrong).** `server/routes/factory/insuranceHistoricalRepairRoutes.ts:259` runs `autoRepairHistoricalInsuranceJournalDirections()` whenever the routes register. In maintenance scope (which also bypasses the closed-period guard) it swaps debit and credit on every company's `INS-%` vouchers that match its pattern, with no audit row. On normalized non-USD lines, the currency trigger reads the swapped amounts again.
2. **A second every-boot rewrite.** `server/routes/sp/index.ts:64` runs `repairSpSupplierVoucherLinks`, which rewrites `supplier_id` on posted vouchers and lines in maintenance scope with no audit. Its trigger (`spSupplierVoucherSync.ts:116–142`) also moves line `supplier_id` whenever an SP container's supplier changes, which moves supplier balances without a voucher.
3. **Unaudited hard delete of intercompany history.** `POST /api/reverse-po-credits` (`admin/adminPoFixRoutes.ts:587–625`) hard-deletes every `INTERCO-%` voucher of a company named in the request, plus parent vouchers matched by `description LIKE` the company name, statement by statement with no transaction and no audit. 47 voucher hard-delete sites remain; linked journals are deleted and re-posted without audit.

### HIGH

- **Audit after commit on the handlers that actually run.** The central Payment/Receipt create, lifecycle and delete, generic voucher create, journal create and stock transfer delete handlers are registered before the legacy ones and audit after commit, swallowing failures. 127 audit calls pass no transaction (wave 12 B claim wrong for these paths).
- **Openings and account types editable by weak roles, outside the journal.** `PUT /api/bank-accounts/:id` needs only sign-in (POS can change a cash opening); `PUT /api/ledger-accounts/:id` accepts `accountType` on accounts with history (retyping Expense to Asset rewrites closed-year P&L). Both accept `companyId`, so an account with lines can be moved to another company. `POST /api/voucher-entries/transfer-account` lets any non-POS user re-point posted lines. Factory supplier and fixed-asset openings are outside the opening lock (wave 12 claim wrong).
- **Lines with no target pass the database.** `erp_voucher_entry_target_guard` accepts a line with no target or several.
- **Closed years would report zero profit.** No report excludes `FISCAL-CLOSE-*`; after a close the P&L, income statement, ratios and dashboard read the closing journal.
- **Fiscal close and two routes still default a sideless opening to Dr** (`fiscal-periods.ts:29`, `accountStatementRoutes.ts`, `accounts/ledger-balance.ts`), against the engine (wave 13A C1 claim wrong). The ledger-balance route also folds linked banks in.
- **Net positions read ledger lines by the account's company,** not the voucher's (`netProfitDataLoad.ts:162,177`, `statsNetPositionRoutes.ts:59`, `calculateNetPositionAsOf.ts:84,99`). In production 8 company 1 lines on company 13 accounts (Dr 1.66M) count in 13's net position but not its balance sheet.
- **Group elimination nets across the whole linked set,** not per pair, so a one-sided mismatch can show as matched.
- **Stock adjustment edit clamps value at zero** (`storage/stock-ops/transfers-update.ts:566–596`), creating the zero-quantity value the readiness tool blocks on (wave 15B claim overstated).
- **Locations can be hard-deleted with stock** (`admin/deleted-items/permanent-delete.ts:216`); production lacks the RESTRICT key.
- **V3 load finalize sells bales with no revenue or COGS,** sign-in only, no transaction, no cut-over guard (`factoryStockAllocationV3Routes.ts:454–490`).
- **Stock-entry bales with no mix are costed at catalogue price** (`stockEntryRoutes.ts:171`, `baleCostBasis.ts:235–246`; wave 11 claim false for them).
- **Non-USD factory invoices never reach the ledger** (`factoryInvoice.ts:113–115`); no factory invoice posts while the switch is off.
- **No factory goods in transit at the opening** (`openingJournal.ts:176–196`): receipts after the cut-over of containers expensed before it credit expense in the new period.

### MEDIUM

- Future rates still used by `getLatestExchangeRate`, `getLatestCfaPerUsd` and the `/api/factory/fx-rates/latest` fallback; `GET /api/factory/fx-rates/:ccy/:date` writes unaudited auto rows, which the repair then uses; deleting a factory currency erases its dated history; the repair's `planHash` is optional and its closed-period check uses `voucher_date` (wave 14A claim partly wrong).
- The currency trigger does nothing for currencies other than USD/CFA.
- Intercompany POS mirror runs after the sale commits, swallows errors and hard-deletes without audit.
- Import-cycle balance and the dashboard expense breakdown are still their own formulas.
- The cut-over apply does not refuse unvalued raw stock or bales, open mixes without a USD rate, or unrepaired FX lines.
- STOCK-IN is one journal per container, rebuilt on each offload.
- Fiscal close writes no audit and fails on deleted P&L accounts; the account delete guard assumes Dr for a sideless opening; a soft-deleted voucher's posting marker is dropped, so a replay re-posts it; floats remain in recurring journals and journal lifecycle.
- No AR/AP aging report on the engine.

### Production (2026-10-09, read-only)

Unchanged in substance since section 9. The plug writer rewrote `equity_adjustment_*` this morning (company 1: −6,375,220.83 at 06:52; company 9 at 05:20). 175 unbalanced vouchers (two new in company 1 on 10-08, one in company 8). No balance guard, no append-only audit_log, no cut-over tables. 82 voucher updates and 7 deletes in company 1 this week rewrote posted entries in place. Every section 9 blocker stands at the same figures; company 10 now also has 3 zero-quantity value rows (159.96). Only 6 dated EUR/AUD factory rates exist, none for February–June.

### Proposed next wave

- **Wave 16, history and audit:** remove the two boot-time rewrites (turn them into reviewed preview/apply tools); put `reverse-po-credits` and the remaining hard deletes behind transactions, roles and audit, or retire them; move every central voucher handler's audit into its transaction; restrict opening, account-type and company changes on accounts with history and journal openings changes; require exactly one line target in the database.
- **Wave 17, reporting and inventory leftovers:** exclude the closing journal from period reports; one sideless-opening rule everywhere; net positions by the voucher's company; per-pair elimination; stock-adjustment edit on the negative-stock model; location delete refused with stock; V3 finalize, no-mix bale cost, non-USD factory invoices and factory goods in transit at the opening; the rate leftovers.
- **Retail Wave 1 on `main`** (payments, cashier shifts and accounting) is new, posts to the ledger, and has not been audited; merging `main` into this branch must be followed by a review of it.
- **Deployment** remains the only way production improves.
