# Cost Centers — Phase 5: Automatic Expense Allocation

## Status

Implementation committed to `feature/cost-centers-phase1-foundation`, preserving
the work in Phases 1–4. Owner requested **no CI checks, test suite, merge, deployment,
or production accounting changes**. Claude will validate and release. No SQL
migrations have been applied to production in this implementation session.

## What is automatic

1. **Company-owned account rules:** authorized Admin/Owner/Developer users map a
   posted **expense ledger account** to one or more active cost centers.
2. **Percentage splits:** each rule group supports multiple centers; percentages
   must be positive and total **at most 100%**. Unassigned remainder is
   `Unallocated`. Split precision is four decimal places for percentage and
   six for native/USD amounts.
3. **Source-specific defaults:** a rule may apply to all source modules or only
   to `ERP` or `FACTORY`. A matching source-specific rule group overrides the
   generic fallback; the two groups are not added together.
4. **New posted expense debit lines:** an AFTER INSERT deferred constraint
   trigger recognizes eligible voucher entries after the source transaction
   completes its ordinary posting/FX writes.
5. **Draft-to-posted transition:** an AFTER UPDATE deferred trigger processes
   eligible expense entries when `vouchers.optional` transitions true→false.
6. **Factory-only standalone daybook expenses:** a separate deferred trigger
   recognizes `EXPENSE`, `OPERATING_EXPENSE`, and `FACTORY_EXPENSE` entries
   only if both `reference_table` and `reference_id` are absent.
7. **Historical FX:** original transaction-currency and historical USD book
   amounts are allocated independently in the recorded proportions. The
   original exchange rate and convention are retained on the analytical rows.
8. **Manual overrides:** manually assigning or clearing an allocation records
   a company-scoped source override. Automation never overwrites an existing
   split or re-adds a split explicitly cleared by the user.
9. **Provenance:** `allocation_origin` distinguishes `AUTO` from `MANUAL`;
   auto rules are linked by `auto_rule_id` where they still exist. The UI shows
   automatic/manual status, and rule modifications use the existing audit log.
10. **Nonblocking diagnostics:** if auto tagging encounters a stale rule,
    its attempted allocation is rolled back independently, the real voucher or
    factory transaction remains postable, and the error is surfaced through
    `GET /automation/failures` in the cost-center page.

## What's deliberately NOT automatic

- **No seeded cost centers or rules:** an administrator explicitly selects the
  correct company, chart-of-accounts source, percentages and target centers.
  Guessing accounts from narration or from names alone is unsafe.
- **No historical backfill** when a rule is created/edited. Phase 7 covers
  controlled historical assignment and reconciliation.
- **No new GL posting or revised supplier/customer/cash/bank balances.**
- **No operational double-counting:** transfers, cash payroll payments, mix
  batches, pending loadings, unfinalized containers, source vouchers mirrored
  into Factory Daybook, and Factory POS expense mirrors do not generate a
  second analytical expense event.
- **No automatic tags on factory inventory movement asset accounts.**
  Internal movement from raw materials to WIP to finished goods can create
  several asset debits for one physical cost; automatic asset debit tagging
  without a landed-cost source identity would triple count. Manual eligible
  inventory-cost tagging remains available from Phase 4, separately from P&L.
- **No inference of a cost center from employee, location, or invoice details**
  unless the source posts to a configured eligible expense account. Future
  source-specific integrations must define one authoritative accounting entry.

Examples: payroll, electricity, maintenance, transport, loading and offloading
**expense ledger accounts** can be mapped after administrators review the
actual account codes. Where freight is capitalized into inventory, it remains
inventory cost and is not auto-expensed by the cost center system.

## Configuration

In **ERP Accounting → Cost Centers** or **Factory Finance → Cost Centers**,
open **Automatic Expense Allocation** and create an account rule. Choose an
expense ledger account, optional source module, active centers and percentages.
Factory Mode also offers standalone nonreferenced daybook expense types.
All mappings are company-isolated and are only applied to future eligible
postings. Edit or disable rules without rewriting prior snapshots.

Only authorized company roles can edit rules. Managers can view mappings.
Source company ID is taken from the authenticated session, not request bodies.
Company FORCED RLS applies to rule, override and failure tables.

## Files

- `migrations/20261021_003_cost_centers_phase5_automation.sql`
- `migrations/meta/_journal.json`
- `shared/schema/cost-centers.ts`
- `server/routes/costCenterRoutes.ts`
- `client/src/components/financial/CostCenterAutomationRules.tsx`
- `client/src/components/financial/VoucherCostCenters.tsx`
- `client/src/pages/CostCenters.tsx`
- `client/src/api/costCentersApi.ts`

## Claude review handoff (not executed here)

Validate Phase 1, 2, 5 migration order and PostgreSQL version compatibility.
Review company RLS context and multi-company access, rule group percent
serialization, deferred trigger effects on hot accounting flows, voucher
finalization, source lifecycle guards, FX precision, Factory Daybook mirror
identification, post-commit error diagnostics, automation provenance,
manual override/clear-all, and UI validation. Run regression checks on
posted accounting balances, perpetual inventory, factory costing, Net
Position and supplier/customer statements before approving any merge/deploy.

The feature is **committed but not production-certified** until Claude completes
review and migration validation. Automatic behavior remains inert with zero
configured rules.
