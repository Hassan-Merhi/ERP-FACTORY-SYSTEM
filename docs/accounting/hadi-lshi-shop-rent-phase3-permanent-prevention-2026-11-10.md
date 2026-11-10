# HADI L'SHI ERP Shop Rentals — Phase 3 permanent prevention

Date: 2026-11-10. Branch: `fix/hadi-lshi-rent-phase3-permanent-prevention-20261110`, branched **from current main**, not the stale audit implementation. Phase 1/2 evidence and guarded historical correction SQL were carried forward as documentation only. This Phase 3 changes **application source code + tests**, not historical transactions.

## Protected live baseline: verified again at 2026-11-10 13:36:02 UTC

| Ledger | Current correct closing | Phase 3 production effects |
|---|---|---|
| #1007 Rent Expense - ERP Shops | $434,350 Dr | No historical entry updated |
| #1021 Accrued Rent Payable | $18,000 Cr | No historical entry updated |
| #1022 Prepaid Rent | $7,000 Dr | **No historical entry updated** |

Other linked records: company #1 HADI L'SHI (ERP payer), company #13 Hassan Properties (owner); active source lease contract IDs **2, 7, 8, 29, 30**, all **PROPERTIES WAREHOUSE** units, combined $18,000 per month. The source leases and the landlord's rent-payment vouchers live in company 13; the actual HADI rent expense and accrued payable entries live in company 1. The 2026 November $18,000 genuine unpaid rent on the source lease remained outstanding as of final read-only Phase 2 verification; its historical accrual voucher #16974 must stay valid. The historical $2,000 STAFF HOUSE July 2026 reconciliation residual remains unchanged and requires separately documented operational evidence.

## Source changes

### 1. Preserve shared month ownership for HADI new accruals
- `server/routes/rental/shared/accrual.ts`: for HADI ERP after 2026-12-01, ensure the five **linked source-owned** lease months exist in company 13. For each due linked lease month from December 2026 onward, recognize the **full expected rent** on HADI: Dr #1007 Rent Expense / Cr #1021 Accrued Rent Payable. The landlord's company 13 cash receipts do **not** prove HADI cleared its own liability or reduce the tenant's expense. 
- Do **not** attempt new historical HADI shared rent accruals for periods through 2026-11, even if an old link was removed. Already-repaired original voucher entries and user's correct existing balances remain unaffected.
- `server/routes/rental/shared/accrual-posting.ts`: extend the locked month/voucher stamping scope **only** when paying company1, ERP module, standard accrual pass, a source company13 active PROPERTIES contract explicitly linked to company1, and **month >= 2026-12**. The same transaction creates the normal legitimate monthly voucher **and stamps every source month** with the original voucher ID. Reject/roll back if any month isn't stamped. No broader cross-company write permission is introduced by these checks.
- Existing standard idempotency protections from main remain: row locks, detection of legacy/orphaned accruals, posting engine idempotency and period-based holds.

### 2. Block the original double-expense accounting pattern at the central posting door
- `server/services/rental/hadiRentLedgerPolicy.ts` exports `isHadiDuplicateLinkedRentExpenseJournal`.
- `server/services/accounting/erpVoucherPosting.ts` rejects **new company1 Journal** entries that debit expense ledger #1007 while crediting either HADI owner credit #867 or HADI Transaction Account #1197 (the same pattern as misclassified original #13386/#15110/#16664).
- Correct Dr Expense #1007 / Cr Payable #1021 monthly accrual, correct Dr Payable #1021 / Cr owner-credit #867 settlement, tenant prepaid recognition Dr Expense / Cr Prepaid, other companies' postings, and historical journals remain permitted. This is intentionally conservative for HADI: where genuinely exceptional expenses need #867/#1197 as counterpart, the operator must review and use the correct existing payable/other accounting pathway rather than silently double-expensing.

### 3. Prevent old maintenance routes from undoing historic corrections
- `server/routes/rental/rentalAccrualConfigRoutes.ts`: refuse HADI ERP `POST /re-accrue` with HTTP 409 `HADI_RENT_HISTORICAL_REPAIR_LOCKED`, because this legacy maintenance operation could create new phantom adjustment journals, clear historic recognition links or retire old vouchers. A normal due-month scheduler/manual accrual remains available through **separate, idempotent posting logic**.
- `DELETE /ledger/:rowId/accrual`: prohibit reversals of HADI ERP months through November 2026; allow newer months through existing validated route. These protections do not block other companies.

### 4. Read-only linked source settlement vs ERP ledger reconciliation
- New service `server/services/rental/hadiLinkedRentProtection.ts`.
- Admin/Developer/authorized rental reconciliation users can GET `/api/<erp-rental-prefix>/linked-rent-control?asOf=YYYY-MM-DD` using existing registration via `server/routes/rentalRouteFactory.ts`.
- Requires authorized read access to **both** HADI company #1 and linked Properties company #13; otherwise responds with 403 from the standard counterparty scope check.
- Shows 5 source contracts, each period's expected rent, only **POSTED payments with a valid active owner-company voucher**, per-month positive rent due, active HADI-owned due, company1 ledger payable #1021, mismatch and invalid posted voucher count. Never nets a different contract's prepaid credit against an unpaid contract.
- Mismatched data returns `status:"REVIEW"` **without** creating or modifying any journal. A reported difference requires original-voucher evidence; no automatic owner-side receipt to tenant-side payable matching/journal is manufactured.

## Verification state and acceptance

Added `tests/hadi-lshi-rent-phase3.test.ts` with 14 pure policy regression cases covering:
- protection of the historical 2026-11 cutoff and correct access to 2026-12 onward,
- correct $18,000 protected payable balance and discrepancies,
- detection of posted voucher missing, per-lease positive due,
- rejection of both historical Dr Expense/Cr owner/transfer journal patterns,
- allowance of correctly classified accruals, settlements, prepaid recognition and other-company postings,
- future HADI month eligibility while denying unlinked/foreign histories.

**Tests are authored/committed, but not executed** (owner previously preferred CI checks separately). Cross-company DB transactions and actual deployment behavior have not yet been proven in a test/staging runtime. Code review and read-only production inspection are distinct from successful deployment.

**No SQL migration or new TablePlus steps required** for Phase 3. This source change performs no historical voucher updates and does not re-run the Phase 2 SQL. The supplied Phase 2 SQL file is archived for evidence — do **not** run it again just to apply Phase 3.

**Rollout status: NOT MERGED / NOT DEPLOYED.** Phase 3 code and tests are committed for owner review. Only after explicitly authorized merge and Render deployment, followed by runtime posting and reconciliation checks, can future live prevention be claimed effective. Normal future rental accruals and legitimate future rent payments still post their ordinary accounting vouchers; only creating *historical correction vouchers* was prohibited.

## Known accounting boundary

Company13 landlord receipt **does not automatically settle** company1 HADI accrued payable, and this Phase 3 deliberately does not invent intercompany or clearing journals. A linked Properties rent payment that doesn't have a corresponding HADI payable settlement causes an actionable **REVIEW**, not an automatic GL mutation. Historical cash, owner-credit, prepaid, voucher and reconciliation residue remain untouched.
