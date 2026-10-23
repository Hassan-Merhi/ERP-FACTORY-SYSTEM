# Unified Accounting — Phase 8: Full Rentals Accounting

**Branch:** `feature/unified-accounting-erp-factory-rentals` (Phases 1–8 together)  
**Modules:** ERP, Factory, Properties/Rentals  
**Handoff:** Claude completes CI, tests, source/build review, accounting certification, then any approved merge/deployment. None of those actions were run in this implementation.

## Design — one authoritative posting engine

Rentals already post through the central ERP voucher engine in all three modules. Phase 8 keeps that ledger and makes it independently explorable by contract, property, unit, tenant, month and company. It does **not** introduce a second rental ledger or rewrite any historical accounting records.

**Accounting perspective**:
- **Tenant-side SHOP leases** and shared/intercompany occupancy across ERP, Factory or Properties use rent expense, accrued rent payable and advance/prepaid assets.
- **Landlord-side WAREHOUSE/non-shop leases** across ERP, Factory or Properties use rental income, rent receivable and (where the existing workflow applies it) deferred rent revenue.
- The existing payment writer determines direction by **unit type (SHOP)** or a **shared lease**, not simply the module name. The Phase 8 report applies that same per-contract classification.
- Deposit assets/liabilities are shown from the actual account used by posted GUAr vouchers. A mismatch between lease perspective and a deposit account type is flagged for manual review; no historical deposit entry is rewritten.
- Ownership and the currency of every contract are explicit. A linked/intercompany contract is **not** assumed to belong to both companies' financial statements. Linked-company settlement remains governed by its existing separate posting source.

Existing posting engines retained:
- `server/services/rental/rentalPaymentPostingService.ts` — atomic and idempotent payment groups, original currency and rate, splitting by billing month, scheduled vs. posted lifecycle.
- `server/services/rental/dueRentalPosting.ts` — company business date, fiscal lock, scheduled group maturity, monthly due accrual/recognition.
- `server/routes/rental/shared/accrual-posting.ts` — balanced central-engine vouchers for monthly expense/payable, advance, prepaid and deferred recognition; group journals can cover several contracts.
- `server/routes/rental/units-contracts/guarantees.ts` and `contract-end.ts` — paid/received guarantee, deposit held, applied as rent, release/return, contract-end refunds. These postings remain separate from rent expense/income, and all existing history remains intact.
- `server/services/rental/rentalPaymentDeletionService.ts` — audited retirement/void of rental payment vouchers and advance recognition, not direct deletion of posted financial history.
- `server/services/rental/rentalPeriodService.ts` — contract billing day and due-date handling, including month-end dates.

## Phase 8 additions

### A. Unified contract-level rental accounting service

`server/services/rental/unifiedRentalAccountingService.ts` provides:

1. Company/module-scoped selection of contracts and their specific unit number, location, tenant, rental amount, billing period, status, contract currency, internal/shared-company flag.
2. Contract-month **expected due rent**, by the existing billing-day rule, and **effective posted payments** allocated against each month. Cached `paid_amount` is compared and flagged rather than treated as authoritative.
3. **Operational rent AR/AP** — amount due less effective POSTED allocations. The label is based on the contract's landlord/tenant role (SHOP/shared = tenant; non-shop = landlord), including within ERP and Factory. This is **not falsely represented as an individually reconstructed general-ledger AR/AP balance**, because monthly accrual journals can combine multiple contracts and advance journals use distinct control accounts.
4. Distinct **scheduled/not-yet-posted** payments, advances allocated to future periods, overpayments on due periods and currently overdue rent.
5. Linked monthly **accrual/recognition voucher ID**, advance/prepaid flags, deleted/orphaned accrual link warnings. A posted journal is read only if company-owned, active, nonoptional, and linked to the period.
6. Exact payment activity with payment group, stored historical FX rate, original currency, allocated month and linked live accounting voucher. `SCHEDULED` rows are viewable even when payment date lies in the future, but **never** count as posted cash or paid rent.
7. Guarantee/deposit accounting evidence from posted `GUAR[-KIND]-number-contractId` voucher families only. Deposit assets on `SEC-DEP-PAID` (debit positive) and tenant-deposit liabilities on `TENANT-DEP` (credit positive) are shown in **USD book basis**, independently of the *native-currency deposit pledge*. No automatic FX repricing or assertion that pledge equals book deposit.
8. Deposit guarantee activity in the rental payments table (`ledger_row_id IS NULL`) is never counted as rent. **Guarantee applied as rent**, when the existing workflow creates real posted monthly allocation rows and a `GUAR-RENT` journal, continues to count as paid rent from those recorded rows; the deposit account book amount decreases through its actual voucher.
9. Support for rent and maintenance/property expense analysis **per contract, per unit** without creating another income, payable, cash or expense journal.
10. Explicit flags when POSTED rows point to missing/retired vouchers, when payment currency differs from contract currency, when cached amounts drift, and when accrual vouchers are no longer active.
11. No mutation or automatic repair of voucher, cash, contract or monthly ledger rows. Source dates are used to filter effective payments and posted voucher entries. Current contract terms and status remain current, **not historically reconstructed** — Phase 10 owns true as-of data lineage.

### B. Audited attribution of existing property/maintenance vouchers

New additive `accounting_rental_expense_links` table, created by
`server/services/rental/ensureRentalAccountingLinksSchema.ts` at always-on startup:

- Links an existing live *posted* expense voucher to one unit/contract and one classified category:
  `maintenance`, `repairs`, `utilities`, `insurance`,
  `property_tax`, `other_property_cost`.
- Stores the **allocated USD/base amount**, a note, actor/time and a durable client request key.
- Multiple contract links may share one source voucher. All active allocation amounts combined must not exceed the voucher's **actual positive expense-side base debit**; conflicting concurrent allocations are serialized by company+voucher advisory lock and source voucher row lock. Base amounts are exact decimals, up to six places.
- Rent-expense and Realized FX accounts are excluded from property-maintenance expense capacity so those amounts are not presented twice.
- **Idempotent replays** with the same request key return the same link, and attempts to replay a modified or voided request are refused. The UI holds a stable request ID across network retries.
- **Revoke/void** requires a reason. Links are soft-voided, not deleted. The audit event records creation and cancellation. Source accounting vouchers remain unchanged.
- Selection requires a company-owned rental contract in the correct module and a source voucher in the same selected company. A voucher dated in the future or whose accounting status is retired/optional is refused.
- Mutations enforce accounting-period availability on the current business date; the original source voucher and historical cash/bank/expense ledger are not edited.
- Company RLS on the new metadata table; no cross-company voucher attribution.
- Historical views include only expense allocations created by the selected as-of date, and retain allocations voided **after** that date. Expense source-voucher edits/deletions cannot always be historically reconstructed, so such retrospective results are not formal audited historical financial statements.

**No extra maintenance expenses are booked.** The accountant first records the real expense in the standard voucher workflow, then attaches the existing voucher's actual expense debit to its rental unit(s). This avoids duplicate costs and respects the existing central posting and bank reconciliation engines.

### C. Secured API

All endpoints use **session-selected company ID** and Admin/Owner/Developer role. Factory calls also require the Factory Accounts page/View Accounts tab permission. The report is read-only except the separate metadata link/void actions.

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/accounting/rentals/contracts?module=ERP\|FACTORY\|PROPERTIES` | List up to 500 company-owned contracts |
| GET | `/api/accounting/rentals/contracts/:id?module=...&asOfDate=YYYY-MM-DD` | Per-unit/contract rent AR/AP, payment schedules, accruals, advances, deposits and expense ledger |
| POST | `/api/accounting/rentals/expense-links` | Attribute one posted expense amount (USD basis) to a contract; requires stable `clientRequestKey` |
| POST | `/api/accounting/rentals/expense-links/:id/void` | Void an attribution with an audited reason |

No endpoint is provided to mass post rent, modify a past accounting voucher, create new control-account balances, or bypass closed periods. The existing due-rent/accrual routes remain authoritative.

### D. Unified UI

New `client/src/pages/UnifiedRentalAccounting.tsx`, accessible from the existing Accounts module and navigation in each system:

- ERP: `/accounting/rentals`
- Factory: `/factory/accounting/rentals`
- Properties/Rentals: `/properties/accounting/rentals`

Features: contract/tenant/unit selector, as-of date, opening operating AR/AP and arrears comparison, month-by-month paid/due/accrual links, posted vs. scheduled payment drilldown including historical rates, guarantee asset/liability voucher evidence, categorized maintenance/repair/property costs, and audited expense attribution or cancellation.

The native contract currency and original USD booked deposit/cost amounts are deliberately shown in **separate labeled totals**. A historical as-of selection disables new expense attributions in the UI; server always enforces the actual business date for any mutation.

## Critical rules and exclusions

- Posted rent means actual `property_payments.posting_status='POSTED'` allocations effective on or before as-of, not SCHEDULED payments, cash transfers, or guessed receipt amounts.
- Monthly accrual obligations recognize income/expenses through the existing engine. The Phase 8 view never re-runs the accrual scheduler on a GET.
- Contract security guarantees are assets for tenant companies and liabilities for landlords. A deposit return, guarantee application or refund is tracked by the existing `GUAR` vouchers; it is not treated as rental income when received.
- Ledger source module, historical FX, original rate and native-currency amounts are not changed.
- Shared or linked-company rent can create accounting records in both companies; this dashboard scopes **only the selected owning company's contract and postings**, not a fabricated consolidated balance. Phase 9 handles intercompany reconciliation.
- Unposted accruals, cash/expense mismatches or deleted vouchers are **flagged for review**, not repaired with speculative journals.
- This phase does not attempt fixed-asset depreciation or capitalize property construction costs without verified asset-level source data.
- Phase 10 is responsible for full historical contract-term/lease modifications and related as-of reporting.
- No production voucher, bank balance, monthly accrued data, rental payment, production inventory, or security guarantee was modified by writing this feature.

## Claude certification checklist (NOT run here)

Claude should independently inspect and verify:

1. All new TypeScript/SQL imports, typed result rows, React routes and navigation; RLS and company scoping in ERP, Factory, Properties.
2. Billing day 28/29/30/31, leap years, late and advanced rent; currency-correct native totals.
3. Scheduled group posting, replay, partial-month splitting, guarantee-applied-as-rent and null ledger-row guarantee activities.
4. Linked-company occupancy, owner vs tenant accounting perspectives and no cross-company record leakage.
5. `accrual_voucher_id` links for standard, advance, prepaid, and deferred recognition; missing/voided links.
6. Security deposit paid, received, applied to rent, refunded and reversed; display of USD ledger basis separate from native pledge.
7. Maintenance/expense source validation, six-decimal caps, matching to actual posted USD expense debit, no duplicate expense posting, and no allocation to rent/realized-FX ledgers.
8. Concurrent links on one voucher, stable request replays, changed-payload conflict and soft-void audit provenance.
9. Edit/retirement of expense source voucher after a link; stale attribution warnings and safe reconciliation.
10. Closed accounting periods, actor validation, permissions, and no posting on GET.
11. Full historical as-of caveats and multi-currency presentation; do **not** mistake current contract terms for historical snapshots.
12. Link creation in the production runtime schema guard after Phase 3–5 tables, without data backfill or mutation.

**Phase 8 is implemented and committed, but has not been built, tested, independently certified, merged, rebased, deployed or used to modify production accounting records.**

### Final source-level distinction

The report's tenant/landlord label follows the existing `postGroupCore`
decision (`isSharedPayment || unitType === "SHOP"`) rather than assuming that
all ERP/Factory contracts are expenses or all Properties contracts are income.
A tenant-side guarantee erroneously stored as a landlord liability, or a
landlord deposit in a tenant asset account, produces an explicit warning.
Legacy guarantee writers themselves are unchanged by this phase; corrections
to prior posted transactions require a separate reviewed accounting action.

