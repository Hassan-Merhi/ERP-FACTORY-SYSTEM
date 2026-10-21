# Unified Accounting — Phase 10: Historical Accounting and As-of Dates

**Branch:** `feature/unified-accounting-erp-factory-rentals` (Phases 1–10, same feature branch)  
**Modules:** ERP, Factory, Properties/Rentals; linked Intercompany/Consolidation  
**Status:** Phase 10 source implementation committed. No CI, tests, build, merge, rebase, deployment, production voucher edit, or automated financial correction performed. Claude is responsible for independent checks and certification.

## Critical distinction — accounting time versus recorded/system time

The accounting system has two fundamentally different questions:

1. **Retrospective accounting date:** What does the **currently active posted ledger**, including journals entered later with earlier effective dates, show when we cut at business date D?
2. **Historically known state:** What exact accounts, balances, vouchers, prices, customer charges, contracts and production costs existed **as known by the company at clock-time T** on that date?

The canonical ERP ledger already answers question 1, using
`COALESCE(vouchers.effective_date, vouchers.voucher_date)`. It does **not**
claim question 2. Many source tables are editable, master openings are mutable,
some vouchers are subsequently soft-deleted, and Factory bale/mix/material
cost changes overwrite historical source fields. Lacking a complete immutable
system-time event history, the past *as-known* state **cannot** be reliably
reconstructed by merely filtering `created_at`.

**Phase 10 explicitly reports what is known and unknown.** It does not call a
retrospective as-of ledger balance a certified historical snapshot and never
invent a past value for a mutable record.

## Implemented components

### A. Historical financial workpaper

Added `server/services/accounting/historicalFinancialWorkpaper.ts`.

For a **single company explicitly selected in the authenticated session**
and an ISO business date `asOfDate`:

- Reuses `buildTrialBalance` and
  `balances/ledgerBalanceEngine.ts`, not a new inconsistent calculation.
  Includes **posted, nonoptional, nondeleted vouchers** whose accounting
  effective dates fall by the selected date; includes master opening
  balances under the canonical one-opening-per-owner rule.
- Recomputes report **opening at the start of the requested period** from
  the master opening + movements *before* `fromDate`.
  Displays movement **within the period** `fromDate`–`asOfDate`.
  Shows closing Dr/Cr, separately for each account and linked party; each
  line is counted once using canonical ledger > bank > fixed asset >
  supplier > employee > factory supplier > customer attribution.
- Carries forward any negative/positive opening on its proper side,
  instead of netting it into a new voucher or inserting a plug.
- Preserves the canonical trial balance's explicitly decomposed unexplained
  difference (opening imbalance, single-sided stock voucher difference and
  other unbalanced posted vouchers).
- Computes income, cost of sales and operating expenses using the existing
  financial-account classifier and **`excludeFiscalClose: true`** from the
  established balance engine, so a fiscal close does not erase period
  revenue/COGS/expenses. Retained earnings/closing entries **remain** in
  the period balance sheet.
- Does **not** reclassify old profit as inventory, reprice original
  purchases/sales, or reinterpret old transaction currencies at today's FX.

### B. Voucher posting chronology and historical evidence

For source vouchers whose effective dates are on/before D, the evidence
reader displays:

- original voucher number, type, stored source module and original currency;
- accounting effective date **versus** creation timestamp;
- current optional/retired status and retirement timestamp;
- original booked historical-base debit/credit amounts **still present in
  today's database** (never fabricated past entry content);
- count and base totals of voucher records **created after D** but bearing
  an effective date on/before D;
- count of original vouchers **retired after D**, which are no longer
  included in today's canonical retrospective posted balance;
- vouchers retired on/before D and today's remaining live source total.

Full evidence counts cover the company; the displayed exceptional source
sample is capped at 100 and marked truncated. A voucher created after D is
not automatically fraud or an unauthorized backdating: later approvals,
retroactive legitimate accounting and company timezone differences matter.
The report shows this as a review signal.

**Date comparison caveat:** creation and retirement timestamps are classified
by PostgreSQL's date-cast calendar, not a historically reconstructed actor
timezone. They should not be relied on alone as proof of accounting date
tampering. Editing existing source details after the posting date may not
be observable from the current voucher/entry rows. Accordingly, there is
no false claim that all historical mutations were detected.

### C. Independent reconciliation and FX timelines

Reports, **without changing any reconciliation or FX postings**:

- Phase 3 party open-item matches applied by D; their actual creation dates,
  live/void status and cancellations after D;
- Phase 4 cash/bank statement imports with statement periods ending by D,
  distinguishing actual import timestamps from bank transaction dates;
- Phase 5 realized FX recognition records with recognized business dates
  through D and actual creation timestamps.

These are **operational evidence**, not separately posted financial
balances. Cancelling an allocation, importing a bank statement or matching
a customer payment does not itself add or remove a journal line.

The established read-only historical currency readiness is included as an
additional signal; it is **not financial certification**. In the system's
pure-legacy compatibility mode, no completed historical FX backfill can
still be reported as 'ready' for compatibility reasons. The historical
workpaper makes this distinction explicit.

#### Phase 10 FX-readiness hardening (subsequent source review)

- The FX diagnostic now applies the same accounting date used in trial
  balances: `COALESCE(v.effective_date, v.voucher_date)`, including the
  live-voucher migration check and the supplier-linked evidence check.
  A later-created voucher backdated by effective date therefore appears in
  the historical FX gate rather than escaping it on its original voucher date.
- The diagnostic reports `legacyCompatibilityMode` separately from `ready`.
  Pure legacy mode remains compatible with pre-backfill reporting but is not
  evidence that historical currency conversion or opening balances are correct.
  The historical route and UI distinguish this from a checked FX basis.
- An entry with a nonzero debit or credit requires its corresponding
  historical base field; partially populated entries no longer escape the
  unresolved-value count. A missing legacy database column may still enter
  compatibility mode, but other database errors are propagated rather than
  silently presented as readiness.
- All changes are source-only, nonposting and do not update historic vouchers,
  currency rates, master openings or production records.

### D. ERP inventory cost replay

`historicalErpStockAtCostTx` delegates to the established
`companyStockValuationAsOf` movement replay, with a distinct endpoint
and UI tab.

- Historical inventory value is calculated from the **recorded movement
  and cost source**; no selling-price revaluation.
- Excludes the Factory bale mirror according to the existing single
  inventory cost reader's policy.
- The resulting replay is **not certified** where source movements or
  cost revisions are incomplete. Current quantity/current cost must never
  be mislabeled historical Factory Raw/WIP/Finished inventory.
- Does **not** post a balancing voucher, enable perpetual accounting,
  update old stock quantities or rewrite landed container cost.

Factory Raw/WIP/Finished historical snapshots cannot be reconstructed
reliably from subsequently overwritten bale/mix costs. The Phase 7
accounting audit intentionally keeps its historical cost comparison
withheld. Phase 10 makes that boundary visible rather than overriding it.

### E. Rentals and group accounting historical scope

- Existing Phase 8 contract-month reports use recorded monthly accrual
  and payment allocation evidence, filtered by payment date, but today's
  mutable contract rent/tenancy status **cannot** be asserted as the
  historic original contract without persisted revisions.
- Existing Phase 9 selected-company consolidation uses per-company
  historical booked USD, but parent investment/ownership links and
  intercompany document provenance cannot be implicitly time-traveled.
- Factory 'VERIFIED', loading or pending orders, including expected
  freight, are **not customer receivables** until finalized by the existing
  Factory posting writer. Phase 10 does not override that policy or
  back-post invoices.

The Phase 10 dashboard connects these separate reports without adding
a second independent accounting balance engine.

## API

Registered in `server/routes/historicalAccountingRoutes.ts` and
`server/routes/applicationRoutes.ts`.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/accounting/history/report?asOfDate=YYYY-MM-DD&fromDate=YYYY-MM-DD` | Retrospective period opening, activity, closing trial balance, P&L, late voucher evidence, allocation/FX metadata, reliability status |
| GET | `/api/accounting/history/erp-stock?asOfDate=YYYY-MM-DD` | Read-only ERP inventory-at-cost historical movement replay |

All routes use the authenticated session company (not query-supplied
company IDs), require **Admin, Owner or Developer**, validate actual ISO
calendar dates, reject fromDate after asOfDate and refuse accounting dates
after the company's business date. Database company-scoping
(`assertTransactionCompanyScope`) applies to the read transaction.
The Factory shared accounting middleware additionally requires the
existing Factory Accounts/View Accounts privilege. No POST, migration,
backfill or correction route was added.

## UI and integrations

New shared `client/src/pages/HistoricalAccounting.tsx`:

- ERP: `/accounting/history`
- Factory: `/factory/accounting/history`
- Properties: `/properties/accounting/history`

Linked in Accounts, ERP Accounting navigation, Properties Accounting
navigation and Factory accounting route registry. Includes period dates,
current posted-source period trial balance, actual opening/movement/closing
columns, provisional period P&L, posting chronology and subsequent
retirements, reconciliation and FX timestamps, separate ERP historical
stock replay and explicit historic source reliability disclosures.

**No check or action on this screen can post, backdate, delete, void, or
change a production accounting voucher.**

## Certification — deliberately blocked

Response carries `reliability.certified=false`,
`historicalKnowledgeAtDate='not_reconstructable'`, independent
blockers/warnings and visible unmatched trial balance differences.

Future fully certified historical system-time reconstruction would require:
- immutable before/after voucher and **voucher-entry** versions, capturing
  posting company, creator, effective date, cancellation and exact
  historic debit/credit/native FX amounts;
- immutable dated master-opening and account/party classification changes;
- immutable Factory material cost, mix/pressing, bale and receipt movement
  versions, linked to finalized container and actual source date;
- versioned rental contract terms, unit status, intercompany relationships;
- per-version company security boundary and fiscal status;
- a defined time-travel/knowledge-cut policy, timestamp timezone rules,
  and deterministic replays of authorized postings.

Those **data sources do not presently exist in a complete and certified
historic form for old records**. This phase does not manufacture or backfill
them and does not claim fully audited historical statements.

## Claude independent certification checklist (NOT executed)

1. Compile TypeScript and route/UI imports, confirm UI privilege parity
   and accessible paths in ERP/Factory/Properties.
2. Verify real ISO dates, company timezones, future as-of refusal and
   cross-company unauthorized access.
3. Compare a period starting Jan 1 with a mid-period custom fromDate:
   opening includes carried-forward ledger movements; period Dr/Cr
   excludes earlier movement; closing remains the same.
4. Compare trial balance and per-party account statements for the exact
   same company/as-of date; no double counted bank or customer-linked
   ledger openings, and no hidden balancing plug.
5. Confirm fiscal closing journals still carry into closing assets/equity
   but do **not** reverse the period P&L calculations.
6. Verify accounting effective dates versus wall-clock voucher insert and
   retirement timestamps; later-entered journals counted as present-day
   hindsight, not as historically existing on D. Retired vouchers remain
   outside the live posted retrospective ledger and appear as evidence.
7. Test sample truncation at 100 and independent full count/cost totals.
8. Verify Phase 3 open-item allocation timestamp/void behavior, Phase 4
   bank statement import timestamps and Phase 5 realized FX dates.
9. Verify currency historical readiness in both migrated and pure-legacy
   mode. Never infer that compatibility fallback implies certified FX
   precision.
10. Compare ERP cost replay to the existing stock valuation service; no
    Factory bale mirror double counting, historical source uncertainty
    hidden or stock mutation.
11. Confirm Factory historical cost, finalized customer invoice and
    freight posting policies remain unchanged. Do not post unfinalized
    freight into customer statements.
12. Inspect renter/landlord role and historical contract-term caveats
    and multi-company consolidation boundaries.
13. Confirm **no POST endpoint or source mutation**, no unauthorized data
    reveal and no automatic accounting revaluation, fiscal adjustments,
    inventory cutover or production backfill.
14. Review all Phase 1–10 code for full accounting certification under
    Claude before an independently approved merge/deployment.

**Phase 10 source implementation is committed, but it is not built,
tested, financially certified, merged or deployed.**
