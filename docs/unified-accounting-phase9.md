# Unified Accounting — Phase 9: Intercompany and Consolidation

**Branch:** `feature/unified-accounting-erp-factory-rentals` (continued from Phases 1–8).  
**Scope:** ERP + Factory + Properties, transfers/loans/rental intercompany balances and consolidated reporting.  
**Implementation:** code committed; **no CI, tests, compilation, merge, rebase, migration execution, accounting voucher mutation or deployment**. Claude owns independent verification and certification.

## Source-of-truth approach

The existing financial ledger is the source of posted balances. Do not invent
a separate consolidated ledger or write hypothetical elimination journals back
into individual subsidiaries. Subsidiaries' posted customer, inventory,
intercompany, cash and rental records must remain exactly as created.

Phase 9 **reuses**:

- `server/services/accounting/balances/ledgerBalanceEngine.ts`:
  canonical company-scoped opening, posting effective date, historical USD/base
  debit and credit, party ownership and current trial-balance rules.
- `server/helpers/groupIntercompany.ts` and
  `server/helpers/groupNetPosition.ts`: existing owner-approved
  company-pair matching, including parent credit links, intercompany transfer
  endpoints, POS configurations and accounts classified `Intercompany`.
- `server/routes/transfers/interCompanyTransferService.ts` and
  `shared/schema/erp/sales-intercompany.ts`: source transfer identity,
  source/destination ledger IDs, paired cash/loan transfer voucher IDs
  and dated USD/base amounts.
- `server/security/companyAccessBoundary.ts`,
  `server/helpers/groupNetPosition.ts#runWithGroupCompanyScope`, and
  `server/services/security/transactionCompanyScope.ts`:
  explicit membership authorization, re-rooted per-company request and
  PostgreSQL RLS context; cross-company reporting is **not** a blanket
  RLS bypass.
- Historical FX readiness from the established
  `historicalCurrencyReadiness` service. No old foreign-currency figures
  are overwritten to make a consolidated balance look correct.

### Group-company membership and hierarchy

- A financial report is requested with an **explicit set of company IDs**.
  Selection is restricted to active companies the authenticated user already
  has permission to access. The user can include ERP, Factory, Properties and
  Supplier Partner companies deliberately, but must not accidentally add an
  inaccessible sister company through its parent's code.
- The existing `companies.parent_company_id` is exposed as provenance.
  Parent/subsidiary status alone is not permission to read, create journals in,
  or eliminate a company's accounts.
- The route requires Admin/Owner/Developer and the existing company/membership
  gate. Factory clients also pass the Factory Accounts/View permission.
- Each company's source balances and transfer voucher are read inside its
  own authorized database scope, not from a single unprotected pooled query.
- The company list and report return only authorized active members; the
  report does not include intercompany counterparties outside the selection
  as if they were part of the consolidated group.

## Phase 9 implementation

### 1. Explicit intercompany account relationships

Updated `server/helpers/groupIntercompany.ts`:

- Includes **active** `intercompany_account_links` pairs in the known
  counterparty relationships, alongside already supported:
  `inter_company_transfers`, `intercompany_pos_configs`,
  `company_settings.parent_credit_account_id`, and chart accounts typed
  `Intercompany`.
- Resolves each configured ledger account to the company that owns it;
  relationships are not guessed by similar-looking account labels.
- A single account used for several counterparties remains a **multi-company**
  group; it is **not** silently divided between two companies.
- Existing Group Net Position's paired account matching remains the same
  algorithm, now with one more authoritative relationship source.
  Claude should compare its prior report before approving the branch, as
  this additional real relationship may change existing matching/residuals.

Also exported the already-used protected
`runWithGroupCompanyScope` helper so Phase 9 does not reimplement its
membership/RLS isolation logic.

### 2. Consolidated USD GL trial balance

New `server/services/accounting/groupConsolidationService.ts`:

- Reads the canonical trial balance **independently for each selected
  company** in chronological member order. This avoids a large parallel
  query queue and preserves tenant RLS context.
- Reports historical original booked **USD base balances** at the supplied
  as-of date, with debit-positive sign and opening-side warnings. Read-only.
- Shows source company, account code, name, party kind, financial category,
  booked balance, current-period movement, hypothetical elimination and
  consolidated balance after accepted eliminations.
- Ledger account classification reuses the existing shared
  `financialStatementCategory` and supports direct/indirect income,
  COGS, expense, asset, liability, equity and party balances. Customer,
  supplier, bank, fixed asset and employee balances remain in their
  authoritative party slots, not duplicated in synthetic GL accounts.
- Unknown/unattributed source balances are surfaced and make the report
  **provisional**, not silently shifted to Miscellaneous.
- The selected date range is `fromDate` → `asOfDate`: a company's booked
  balance is through as-of; income/expense movement is the period's
  posted activity, using the canonical engine's `excludeFiscalClose`
  treatment for income, expense and COGS. The balance sheet and trial
  balance still **include** posted period-closing journals. The display
  defaults to January 1 through today's date.
- Consolidated totals include asset, liability, equity, income,
  COGS, operating expense, pre-internal-sales-elimination period result,
  and gross/adjusted trial balance debit/credit totals.
- Functional/base currency for every included company must already be
  USD. The report does **not** silently translate a non-USD functional
  ledger with an arbitrary FX rate.

### 3. Paired intercompany eliminations — presentation only

The existing pair matcher supplies candidate debit/credit balances, grouped
by authoritative account links. The new workpaper further checks that an
elimination is supportable **on named ledger account lines**:

- Two companies only, with a recorded owner/counterparty relationship.
- Live, recognized individual linked ledger accounts in both company
  trial balances; matched as-of USD balances agree with the central
  party-balance engine (tolerance USD 0.01).
- Positive intercompany receivables and negative intercompany payables are
  in *different companies*; mixed asset/liability sides within one company
  cannot be force-netted against an arbitrary account.
- Only the matched amount is eliminated. A residual difference remains
  visible. An unpaired account or multi-company relationship cannot be
  presumed to match another company's account based on name.
- The balancing illustrative adjustment is:
  `Dr Intercompany Payable (credit-side company), Cr Intercompany Receivable (debit-side company)`
  **in the consolidation worksheet only**.
- No per-company `vouchers`/`voucher_entries`, `inter_company_transfers`,
  `company_settings`, `accounting_fx_realizations`, cash/bank,
  subledger, rent payable or inventory data are written.
- If a pair cannot be *completely mapped* to legitimate ledger lines, all
  potential adjustments for that pair are **discarded** and its unmatched
  reason is reported. Partial hypothetical entries are not advertised as
  already applied.
- Sum of reported hypothetical Dr and Cr is equal by construction; there
  is no hidden group-level plug account.

### 4. Loan and cash transfer source integrity

New `server/services/accounting/groupTransferEvidence.ts`:

- Audits each selected company's latest 250 outgoing
  `inter_company_transfers` up to the selected date, *only* when its
  destination company is also selected and authorized.
- Retrieves both referenced vouchers **separately**, each in the posting
  company's own PostgreSQL company/RLS scope.
- Compares the original `from_ledger_account_id` and
  `to_ledger_account_id` journal lines against the transfer source amount,
  accounting date, company and each other's opposite sign.
- Differentiates `matched`, `missing_from_voucher`,
  `missing_to_voucher`, `retired_leg`,
  `missing_ledger_leg`, `date_mismatch`,
  `direction_mismatch`, `amount_mismatch`.
- As-of and 250-row truncation are disclosed. No transfer correction
  vouchers are issued.
- Source voucher numbers and **owning companies** are displayed as
  references. The UI does not link a destination-company voucher into the
  currently selected company's voucher route (which could open an unrelated
  record).

### 5. Security and common UI

New endpoints in `server/routes/groupConsolidationRoutes.ts`:

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/accounting/consolidation/companies` | Active accessible companies and parent relationship |
| GET | `/api/accounting/consolidation/report?companyIds=1,2&fromDate=YYYY-MM-DD&asOfDate=YYYY-MM-DD` | USD trial balance, paired elimination, residuals and provisional management statement |
| GET | `/api/accounting/consolidation/transfers?companyIds=1,2&asOfDate=YYYY-MM-DD` | Each outgoing Cash/Loan transfer's live counterpart journal evidence |

Routes are mounted in `server/routes/applicationRoutes.ts`, with
Factory access restrictions in
`server/middleware/sharedFactoryAccessBoundary.ts`.

New unified `client/src/pages/GroupConsolidationAccounting.tsx`,
lazy-loaded in ERP/Factory/Properties:

- ERP: `/accounting/consolidation`
- Factory: `/factory/accounting/consolidation`
- Properties: `/properties/accounting/consolidation`

The page is linked from the existing Accounts screen in each module and
the ERP/Properties Accounting navigation. Factory reuses its existing Accounts
access registry. There are company checkboxes, period dates, a summary,
reconciliation pair table, transfer source evidence, per-company trial
balance and elimination workpaper.

## Accounting considerations NOT silently assumed completed

**1. Distinguish Group Net Position from consolidation:** Group Net Position
is a management balance sheet with pre-existing exclusions for Factory,
Supplier Partner and some other company types and live FX display. This
new group GL workpaper includes whatever authorized companies are explicitly
selected, uses booked historical USD and **does not** call Group Net
Position then eliminate its intercompany accounts a second time.

**2. Intercompany revenue and profit:** Pairing an intercompany receivable
and payable is **not** sufficient to eliminate internal trading revenue,
intercompany COGS, unrealized stock-in-group profit, internal rent or
shared-company expenses. Document-level transaction provenance is required
for those (e.g. invoice ID, internal counterparty and receipt side). This
report deliberately does **not** certify elimination of those amounts.

**3. Parent investments and equity:** No assumption that every company is
100%-owned, that ownership percentages or purchase accounting are known,
or that shareholder funding, loans and noncontrolling interests can be
eliminated from names alone. Formal consolidated balance sheets require
verified investment/equity relationships and period-close mapping.

**4. Loan versus cash transfer:** A source Cash/Loan transfer changes
two companies' cash/receivable/payable accounts; the loan principal alone
is not group income. Both source vouchers are reviewed before the loan
pair is treated as reconciled. Internal source transfer cash movements
must not be counted as group operating cash flow.

**5. Cross-company Properties rental:** A linked property lease can post
rent expense in one company and rent income in another. The existing
Phase 8 report keeps those contracts scoped. It is not appropriate to
eliminate all properties' rental income or all shops' rent expenses.
Intercompany rent-profit elimination requires paired document evidence.

**6. Historical costs/FX:** The report displays original booked USD with
per-company FX readiness flags. Any missing historical base currency,
mutable opening balances, historical source corrections or production
cost snapshots needs review. Phase 10 owns fuller historical reconstruction.

**7. Closing statements:** The Phase 9 output is a
`PROVISIONAL_LEDGER_CONSOLIDATION` and explicitly returns
`certified:false`. Formal financial statements with complete eliminated
intercompany sales, investment/equity, correct fiscal closing, cash flow,
minority-interest handling and a proper audit trail belong to the
cross-module financial statement certification in Phase 11.

**8. Preserved company controls:** No changes to outside Factory supplier
balances, ERP/Factory Net Position's cost/selling toggle, Factory finalization
rules, rental deposits/advances, cash FX revaluation, or existing period locks.

## Claude certification checklist — unexecuted here

1. Validate all TypeScript/React/SQL route schemas and code compatibility.
2. Check existing Group Net Position paired balances **before vs. after**
   adding explicit `intercompany_account_links`; ensure no duplicate
   pairing or multi-counterparty cross-allocation.
3. Validate authenticated company membership enforcement and per-company
   PostgreSQL RLS on ledger, transfer source and counterpart voucher reads.
   Test an Owner authorized for only one subsidiary; no sister-company data
   must leak, and no unowned company may appear by parent relationship alone.
4. Verify ledger historical opening, account side and party ownership
   assumptions, account types, COGS categories and net trial balance.
5. Check paired Dr/Cr elimination for A↔B, A↔C (shared account), unmatched,
   same-side, mixed-side, partially matching and deleted account scenarios.
   No failed workpaper adjustment may be applied to reported totals.
6. Test cash and loan source transfers across company boundaries, missing
   linked voucher, mismatched amount, retired leg, wrong date and truncated
   report coverage.
7. Confirm internal rental receivable/payable, intercompany POS and parent
   credit references are included via their recorded account-link sources,
   but not claimed as fully eliminated source sales/expenses.
8. Confirm original posted source vouchers and FX rates never change under
   report GETs. No automatic correcting voucher, RLS bypass or production
   posting.
9. Check UI only allows authorized company checkboxes; no cross-company
   voucher links that resolve in the wrong selected company.
10. Review historical FX readiness and company base-currency requirements,
    account classification, formal certification disclaimers, and comparison
    of Group Net Position's different company scope.
11. Confirm no unreviewed intercompany profits or parent equity have been
    presented as certified financial statements.
12. Run CI/tests/build **only under Claude's independent checks**, then
    decide separately on merge or deployment after financial signoff.

**Phase 9 implementation and handoff are committed to the feature branch.
No CI, tests, merge, rebase, production data operations or deployment
were run here.**
