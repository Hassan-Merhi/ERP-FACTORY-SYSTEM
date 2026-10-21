# Unified Accounting — Phase 12: Cost Centers, Analytic Accounting & Budgets

**Branch:** `feature/unified-accounting-erp-factory-rentals` (same feature branch as Phases 1–11)  
**Modules:** ERP, Factory, Properties/Rentals  
**Handoff:** Claude performs independent source checks, TypeScript/build, CI, tests, accounting validation and eventual approved merge/deploy. **None of those checks/actions were run during Phase 12.** All changes are source and additive metadata definitions; no production vouchers, journal entries, posting amounts, inventory, cash, bank or FX rates were changed.

## Accounting model and protections

A cost center is **not** a second chart-of-accounts account. It is an analytic
dimension for a posted income, COGS or expense line of the existing ERP/Factory/
Properties voucher ledger. A department, project, warehouse, factory production
line, rental property, operating site or shared admin center can be modeled with
a code, name, module and optional parent. The same posted line may be split
among multiple centers by an audited percentage **represented as an exact USD
amount**.

- Only posted/live/nonoptional entries from the **current company**, on a
  recognized income/COGS/expense `ledger_accounts` row, are eligible.
  Unknown accounts and cash/bank, debt, pure asset or equity lines are not
  treated as cost-center expenses simply because money was transferred.
- An assignment references the **original immutable voucher entry ID**;
  no voucher `INSERT`, `UPDATE`, `DELETE`, `reversal` or accounting
  journal adjustment is performed here.
- `amount_usd` means *part of the historical posted BASE USD magnitude*
  of that **specific voucher line**. A debit-negative expense (return/credit)
  reduces actual expenses. An income debit (refund) reduces actual revenue.
  Actual budget signs follow the original journal, never a current FX rate.
- Many centers can share one voucher line. Combined active allocations must
  not exceed its **actual booked base USD absolute value**. The writer locks
  the source voucher AND original voucher entry and rechecks allocation
  capacity under the same database transaction. One stable request key
  prevents retries from double-assigning the entry.
- A voucher reverse/cancel or retired original does not silently change
  an old financial record. Active analytic tags whose source is now
  reversed/retired are flagged and excluded from eligible current actuals.
  Reverse vouchers themselves are never eligible for new allocation.
- A source line whose present booked amount becomes smaller than its prior
  analytic allocation sum is **not** presented as extra center spending.
  The original source value is shown under *unallocated / requires review*
  and the overallocated item count is a visible source-integrity warning.
- Only currently open accounting periods can accept a new or voided source
  attribution. A closed-period source voucher cannot be silently retagged.
- The balance sheet, professional income statement, Factory net position,
  supplier statements, payroll, produced-bale costs, POS sales and source
  accounting books continue to come from their established posting engines.

## Additive database schema

New `server/services/accounting/ensureAnalyticAccountingSchema.ts`, called
by the **always-on** `ensureRuntimeSchema` guard because production does
not necessarily run bulk migrations at startup.

The schema contains **three metadata-only tables**, all with company-local
PostgreSQL RLS including `FORCE ROW LEVEL SECURITY`:

1. `accounting_cost_centers`: immutable numerical ID, company ID, unique
   company-code, stable name, module `ERP` / `FACTORY` / `PROPERTIES` /
   `SHARED`, optional parent, order, active flag, note and actor/timestamps.
   Parent and child are guaranteed to share company via a composite FK.
2. `accounting_cost_allocations`: exact original `voucher_entry_id`,
   `cost_center_id`, company, six-decimal USD allocation, note, durable
   company-wide idempotency key, author/timestamp, soft-void timestamp,
   author and mandatory cancellation reason. Composite FK prevents linking
   a center from another company. A database write trigger also
   verifies that `voucher_entries.company_id` matches the allocation's
   company, preventing cross-company source-entry linking even when a caller
   bypasses the application-level service.
3. `accounting_cost_budgets`: month-start date, company and center,
   `income` / `cost_of_sales` / `expense` category, USD planned
   magnitude, `DRAFT` / `APPROVED` / `ARCHIVED` state, actual
   approver timestamp and archive reason, with source actor records.
   Only **one nonarchived** plan may exist for a specific
   (company, center, calendar month, category). Approved plan amounts
   are **immutable**; archive the version with a reason before creating
   a replacement draft. Composite FK requires same-company center.

Schema operations are idempotent, constrained and do not backfill, seed,
activate GL cutovers or alter pre-existing voucher/stock tables. No
separate analytical adjustment voucher is created.

## Operational and financial services

### Cost center and hierarchy

`server/services/accounting/analyticAccountingService.ts`:

- Create center and edit its label/code/module/parent/order/active state.
- Reject malformed code/name, parent owned by another company, inactive
  parent, direct self-parent or transitive cycle.
- Serialize hierarchy reparent/creation per company using transaction
  advisory locks; no cross-company parent lookup or shared hierarchy
  bypass.
- Deactivating a center prevents **new** allocations and budgets but
  retains prior assignments and history.
- Child totals roll up to all ancestors; the group total never re-adds
  the same source value through both child and parent.

### Manual allocation of posted journal lines

- Search up to 100 newest **eligible** posted income, COGS or expense
  voucher lines by voucher number or account code/name. Display source
  ID, actual voucher number, date, booked amount, classification, assigned
  and unassigned USD.
- Create a six-decimal-positive attribution to any active center in the
  same company with a durable `clientRequestKey`. Concurrent requests on
  one voucher and source line cannot overallocate.
- Identical retries return the same attribution record. Changed retry
  payloads or already-voided request keys fail closed.
- Cancel a tag with an actor and mandatory reason; soft-void preserves
  its audit history. No financial voucher reversal is triggered.
- Company isolation, audit events and current accounting-period protection
  are enforced in the backend, not only by React controls.

The design **does not** automatically infer a voucher's cost center
from its location or memo. Staff assign the verified source to the correct
department/project rather than silently assigning shared costs.
Operational auto-mapping and future voucher-entry UI defaults, if later
needed, require separate documented policy and testing; this phase does
not invent them.

### Monthly budgets and controlled approval

- Create a `DRAFT` USD month/category/center budget for the current or
  future business month; historical budgets are never retroactively made
  to look like original approved plans.
- Approve a draft with an actor/timestamp. Approved plan amount cannot
  be edited. An approved version may be archived with a mandatory reason,
  then a new draft may replace it.
- Archive a draft with reason; archived historical versions are preserved
  with their original fields and never used as the current approved plan.
- Use approved budget in variance only; draft plans remain visibly
  separate. Zero approved plan is **not** falsely interpreted as a
  complete/planned zero budget.
- Budget approval and archive never issue a financial journal voucher or
  adjust profit, balances, asset values or bank/cash.

### Actual-versus-budget and analytic rollup

New `server/services/accounting/analyticBudgetReport.ts`:

- Uses only existing **posted effective-dated** USD source voucher entries
  with the original `financialStatementCategory` (Income / COGS / Expense)
  account classification.
- Excludes fiscal closing journals from expense/income performance via
  `notFiscalClosingVoucher`, matching Phase 10/11 P&L treatment.
- Includes source-posting amounts directly assigned to a cost center,
  including signed adjustments and returns.
- Calculates **unallocated** remainder per voucher **entry**, not per
  voucher header, avoiding duplicated totals when one voucher has many
  lines and center assignments.
- When a source record has become overallocated due to later edits,
  all its eligible value is held as *unallocated* and the over-allocation
  count is reported. No source data are repaired automatically.
- Excludes reversal pairs only after the reversal's effective date. Does
  not treat an old reversal as evidence that the original voucher never
  existed before that date.
- Produces **direct** per-center totals, each parent's **rolledUp**
  totals, per-month center/category breakdown, direct unique-company
  totals, source unallocated totals, approved budgets and drafts.
- For income, *favorable variance* = Actual Income − Approved Plan.
  For expenses/COGS, favorable variance = Approved Plan − Actual Cost.
  Negative amounts are displayed as unfavorable, not silently clamped.
- Parent and child rolled-up rows are never added together into the
  unique company total.
- Reports whole-month plan even if a selected time range covers only
  part of the month, with explicit disclosure.
- Returns `certified:false`, source-drift warnings, archived budget
  limitation and current-definition-vs-history limitation. It does not
  claim immutable past-date hierarchy or approved-budget version history
  is reconstructable from currently editable structures.

## Secured API and application integration

New `server/routes/analyticAccountingRoutes.ts`, registered in the
existing application routes. All endpoints:
- require authenticated **Admin, Owner or Developer**;
- derive current company ID from session, not caller-supplied company ID;
- perform `assertTransactionCompanyScope` under PostgreSQL RLS;
- follow Factory Accounts/View Accounts page-level permission gate;
- never create or amend financial source vouchers.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/accounting/analytics/centers` | GET, POST | List and create centers |
| `/api/accounting/analytics/centers/:id` | PUT | Edit, reorder, deactivate, reparent |
| `/api/accounting/analytics/entries?search=...` | GET | Find eligible voucher lines and available USD |
| `/api/accounting/analytics/allocations` | GET, POST | Review and add assignments |
| `/api/accounting/analytics/allocations/:id/void` | POST | Audited cancellation |
| `/api/accounting/analytics/budgets` | GET, POST | Read and create monthly draft plan |
| `/api/accounting/analytics/budgets/:id/approve` | POST | Approve a draft |
| `/api/accounting/analytics/budgets/:id/archive` | POST | Archive version with reason |
| `/api/accounting/analytics/report` | GET | Signed actuals, approved/draft budgets, direct and hierarchy rollups, months, variances, unallocated |

New `client/src/pages/CostCenterAccounting.tsx`, accessible via:

| Module | Page |
| --- | --- |
| ERP | `/accounting/cost-centers` |
| Factory | `/factory/accounting/cost-centers` |
| Properties | `/properties/accounting/cost-centers` |

Screen includes overview with company/period scope; direct and rolled-up
budget-versus-actual and separate unallocated financial lines; center
create/edit/hierarchy/order/status; posted voucher search and allocation;
cancellation with required reason; draft budget creation, approval and
version archiving; per-calendar-month details; integrity warnings; Excel
CSV export (formula-like source labels escaped). Query cache is scoped by
company ID, so switching companies does not display another company's
cached finance data.

The page is linked from existing shared Accounts UI and ERP/Properties
Accounting sidebars; Factory uses its existing Finance/Accounts permission
registry.

## Cross-module interpretation

- **ERP:** Operating store/department/project/location source expense and
  income postings can be classified by center at actual booked historic USD.
  Inventory purchases capitalized to the INVENTORY asset account are not
  expenses; only recognized COGS/income/expense lines are assignable.
- **Factory:** Factory RAW/WIP/FINISHED asset changes are not incorrectly
  treated as P&L merely because raw material or bales moved.
  Recognized Factory bale sales revenue, production variance expense and
  COGS entries can be attributed once the underlying journal is posted.
  Pending-loading/unfinalized freight must not become customer revenue.
- **Properties:** Posted rent expense/income and actual property maintenance
  vouchers may be attributed to a unit/property center without duplicating
  rent receivables or security deposit liabilities. Phase 8 source voucher
  maintenance links and this cost-center classification are two views of
  the **same posted expense**, never two expenses.
- **Intercompany:** Cross-company transfers themselves are balance sheet
  lines rather than group income/cost, so they are not assigned as a local
  center expense. Shared charges may be allocated to a SHARED cost center
  within each source company, but no new intercompany settlement journal
  is created here.

## Claude certification and rollout checklist — not executed

1. TypeScript, React, API and SQL build validity, route lazy-import and
   UI state transitions. Do not assume source review constitutes tests.
2. PostgreSQL boot idempotency for all three tables, the voucher-entry company ownership trigger, partial unique
   indexes, ownership composite FKs, FORCED RLS and cross-company
   selector/parent/entry/budget rejection.
3. Parent tree from 2 to 5 levels, missing parent, deactivation, reparent
   cycle, concurrent edits and company-wide hierarchy serialized writes.
4. Source eligibility: normal credit revenue, debit expense, contra
   debit revenue, credited expense, recognized COGS, non-eligible bank,
   asset, liability, payroll payable, tax liability and equity lines.
5. 0.01–six-decimal allocations, multiple centers on one posted voucher
   line, concurrent attempts to overallocate, replay same key, changed
   payload with same key, and voided record retry.
6. Locking against source voucher and source entry amendments, and
   explicit change of source historical booked USD after allocation.
   A drifted source entry must **not** increase attributed actual.
7. Reversed/cancelled source voucher pair at today's date and at an
   as-of date before the reversal: do not silently duplicate credits.
8. Only cost-center metadata changes on POST/PUT/void; verify **no**
   changes to `vouchers`, `voucher_entries`, rates, bank, factory
   stock/production, rental payments or historical accounting journals.
9. Fiscal close blocks attribution changes inside closed periods.
   Budget planning and approval cannot be falsely retrodated to old months.
10. Two distinct centers with one parent: direct amounts vs. ancestor
    rolledUp vs. company totals exactly equals source book actual;
    no multiplication through parent-child aggregation.
11. Forecast month budget, approval vs. draft, repeated budget key,
    archive with reason and new version. Approved plan frozen.
12. Budget variance signs: income vs. cost, zero approved plan,
    negative corrections, and partial-month vs. full-month budget warning.
13. Company switch, source line search and capped results, mobile UX,
    CSV field escaping and screen navigation under ERP/Factory/Properties.
14. Multi-currency USD historic source values, including incomplete
    legacy base columns and FX transactions; never infer current FX.
15. Verify that a Factory unfinalized container freight and a rental
    security deposit cannot be treated as income/expense just because
    they have cash or an expected payment.
16. Cross-check Phase 11 formal trial balance and P&L vs. total analytic
    eligible amounts and unallocated account activity; do not confuse
    management cost centers with posted cost/revenue GL balances.
17. Run CI, tests, accounting data validation and security certification
    **only when Claude takes over**; do not merge or deploy from this phase.

**Phase 12 source implementation and documentation complete on the same feature
branch, subject to Claude's independent compile/CI/tests/accounting
certification. No production financial records were modified here.**
