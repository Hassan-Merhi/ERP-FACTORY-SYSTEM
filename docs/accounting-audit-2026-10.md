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
- **Not done (remaining risk):** PO line-item / charge edits outside one transaction; factory container create; factory payroll "mark PAID" posts no cash voucher and one payroll generator posts no accrual; advance delete leaves repayment vouchers; inter-company counterpart re-scaling outside the edit transaction (converted in 8.5); a database balance constraint (installed in 8.5 for perpetual-inventory companies from their cut-over).

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
  - net position reads no bank accounts at all (an existing gap, reported).
- Tests: `wave10-engine-consolidation`, `wave10-net-position-engine`; updated `wave10-party-reader-rules`, `phase33d-employee-net-position`, `stats-net-position-excel-behavior`, `account-statement-*`, `perpetual-inventory-factory`, `report-endpoint-characterization` (pins regenerated).

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
