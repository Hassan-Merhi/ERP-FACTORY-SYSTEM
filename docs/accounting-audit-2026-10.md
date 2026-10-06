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
- **Note:** in production these boot rewriters were already failing every boot because the startup client has no tenant scope and the ledger tables use FORCE ROW LEVEL SECURITY; they were latent, not active.
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
