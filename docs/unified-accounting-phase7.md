# Unified Accounting — Phase 7: Factory Production and Container Accounting

**Branch:** `feature/unified-accounting-erp-factory-rentals`  
**Modules:** Factory with shared ERP Accounting access  
**Handoff:** Claude performs source review, CI, compilation, tests, certification, and eventually integrates. The work here performed **none** of those operations.

## Core accounting rule

The Factory model **already has authoritative posting and cost engines**.
Phase 7 does **not** introduce a second ledger, speculative daily stock
transaction postings, synthetic bale costs, or historical voucher repairs.
It makes the existing Factory production-to-finance bridge observable,
keeps invoice/charge finalization protections, and uses one company-scoped,
read-only audit.

Existing source files preserved and reused:

- `server/services/accounting/perpetualInventory/factoryValuation.ts`
  — raw material remaining kg × verified USD landed cost/kg, work in progress
  cost, finished bales at recorded cost; reserved bales on open orders remain
  inventory. Unpriced sources are identified rather than guessed.
- `server/services/accounting/perpetualInventory/factoryStockJournal.ts`
  — established `GL-FACTORY-STOCK-{companyId}-{date}` daily journal consolidates
  raw, WIP and finished changes, including receipt credits, waste,
  re-costing, material price variance and production variance. It is
  **today-only**; historic days are never re-posted. This source remains
  untouched.
- `server/services/accounting/perpetualInventory/factoryInvoice.ts`
  — `INV-GL-{companyId}-{orderId}` for FINALIZED orders: Dr customer ledger,
  Cr Factory Bale Sales Income; after the approved perpetual cutover,
  Dr Cost of Goods Sold and Cr Factory Finished Goods at the bales'
  recorded USD cost. Existing Factory FX-rate-on-date and matched charge
  deductions remain authoritative.
- `server/routes/factory/customer-orders/orderChargeLedger.ts`
  — CHARGE voucher writer refuses a non-FINALIZED order, preventing
  early Freight/Charges from being posted to customers. Financial amounts
  update under its existing transaction and permissions.
- `server/services/factory/baleCostBasis.ts` — USD-only source rates, locked
  supplier moving average or container USD landed cost, and pressing cost.
  Missing cost is a refusal after cutover, not arbitrary zero/native cost.
- `server/services/accounting/perpetualInventory/cutover.ts`
  — unchanged **`PERPETUAL_INVENTORY_POSTING_READY = false`**. No
  cutover or new GL factory stock postings were activated.

### Exact stages retained

| Operational stage | Inventory / GL meaning |
| --- | --- |
| Container scheduled / pending / OTW | Operational shipment/expected quantity. Not automatically received Factory raw stock; an unfinalized customer shipment is not an invoice. |
| Factory receipt / offload | Incremental received kilograms with the persisted first-offload fixed native and USD cost; receipt evidence remains separate from cash or customer balances. |
| Raw material remaining | `factory_raw_stock.received_kg - used_kg` × source's USD landed cost. Only live rows qualify; missing USD rate is explicitly unvalued. |
| New mix | Factory raw is consumed into Factory WIP at recorded USD material cost, including source cost selection rules. |
| Bale production / pressing | Recorded mix source cost moves WIP to Factory Finished Goods; bales awaiting pressing remain WIP. No use of sales price as inventory asset cost. |
| Loaded / VERIFIED customer order | Reserved finished-goods stock continues to be valued at cost. Freight charges are *not* posted to customer statements. |
| FINALIZED customer invoice | Existing invoice voucher recognizes receivable and sales revenue, with separately posted charge vouchers subtracted once. COGS/finished-goods lines are included only when company perpetual cutover applies. |
| Bale returns, write-off, re-cost | Existing signed Factory stock events and daily GL variance categories handle these, never a direct rerating of historical sales. |

## Phase 7 implementation

### New source-level accounting audit

Added `server/services/accounting/perpetualInventory/factoryProductionAccountingAudit.ts`:

1. **Container receipts and USD landed cost:** active factory containers
   (latest 200), incremental receipt event count/kg/USD, earliest/latest receipt
   date, raw stock received/used/current USD value, container native currency,
   confirmed FX marker and missing cost flags. Foreign container FX is
   only flagged when its stock was actually received (OTW is not a false
   missing-price accounting error). Legacy raw stock without a receipt log is
   flagged for investigation, not fabricated or deleted.
2. **Factory stock position:** reused `factoryStockValuation(tx,companyId)`
   reports cost at Raw, WIP, Finished and total, unvalued source list, reserved
   stock on open orders, and sold-not-invoiced bales. The existing
   `factoryGoodsInTransitHeld` supplies the GIT position for the selected
   date.
3. **Financial control account link:** only on the *current business date* for
   an eligible company with an applied cutover, show GL account balances and
   differences for:
   `FACTORY_RAW_MATERIAL_STOCK`, `FACTORY_WIP`,
   `FACTORY_FINISHED_GOODS`, `FACTORY_GOODS_IN_TRANSIT`.
   Otherwise the comparison is **withheld**, as those current overwritten
   cost rows are not historical evidence and periodic GL is not perpetual.
4. **Daily stock journal evidence:** trace the live
   `GL-FACTORY-STOCK-{company}-{date}` voucher without running the journal or
   mutating `factory_stock_value_events`.
5. **Customer invoice evidence:** active customer orders (latest 200)
   and links to `INV-GL` vouchers, recorded grand total, current amount of
   vouchered independent order charges, net receivable, bale count, USD cost,
   posted customer receivable, COGS and Factory Finished credit. Detect absent
   finalized invoices, date discrepancies, missing/inactive charge links,
   unvalued bales after cutover and apparent cost mismatches.
6. **Premature customer liability guard:** the audit highlights an active
   invoice or active posted order charge on any non-FINALIZED order as
   **critical** for current date. This does not silently void its voucher
   or alter statement balances; all corrections require a reviewed journal
   lifecycle.
7. **Legacy charge link support:** when an old charge row's `voucher_id`
   is null, look for its original `CHARGE-PRE-{order}-{charge}` or
   `CHARGE-{invoice}-{charge}-*` number with a verified customer-side voucher
   line amount, matching the existing invoice poster's legacy fallback.
   Charge vouchers are not double-counted by invoice revenue.
8. **Foreign-currency receivable protection:** USD journal amounts are taken
   from the posted USD ledger. Non-USD journals use the posted native
   transaction debit/credit evidence, and missing native columns are
   withheld instead of inferring exchange rates. No normalization/backfill.
9. **History caveat:** an arbitrary past source-date cutoff is useful for
   receipt event selection, but order status, source live/deleted state,
   already-issued vouchers and raw/mix/bale costs cannot all be reconstructed
   at that date from mutable current rows. Such past-date invoices are
   **review only**, never labeled historical posting violations; old cost-to-GL
   differences are withheld. Full as-of reconstruction is Phase 10's scope.
10. All values use decimal arithmetic; stock is **at cost**, and
    as-of unavailable or unverified amounts are displayed as unverified,
    never invented. Returned document sets are capped and explicitly marked
    truncated at 200 per type.

### API

New endpoint:
`GET /api/accounting/factory-production/audit?asOfDate=YYYY-MM-DD`.

The report takes company identity from the authenticated session,
requires **Admin, Owner or Developer**, and asserts the selected PostgreSQL
transaction company scope. The existing Factory shared access boundary
additionally requires Factory Accounts page and View Accounts tab permission.

This is a **GET-only read surface**: no apply, sync, repair, post, delete,
rate-rewrite, inventory edit, production update, cutover, or SQL backfill
endpoint is added.

### UI and navigation

New shared screen: `client/src/pages/FactoryProductionAccounting.tsx`.

- **ERP:** `/accounting/factory-production`
- **Factory:** `/factory/accounting/production`

ERP Accounting navigation now includes Factory Production Accounting.
ERP and Factory Accounts link to the report. Factory's route aliases reuse
`factory/accounts` authorization, avoiding an unprotected finance page.
The standalone Accounts shortcut is intentionally not shown in
Properties/Rentals, where this is not an applicable operation.

The screen presents raw/WIP/finished/GIT, reserve-for-open and sold-not-invoiced
costs, source reports, current or historical caveats, filterable invoice and
container issues, and source voucher links. Its primary affordance is
**investigate**, not auto-fix.

## Existing rules left unchanged

- Factory billing *only* after FINALIZED. VERIFIED and LOADING container
  bales stay inventory and are not a receivable merely because they were
  loaded or had expected freight.
- Container finalization date controls Factory invoice business date according
  to the existing writer's `COALESCE(finalized_at,created_at)` rule. No new
  backdating of historical vouchers.
- Factory full and partial offloads, native and USD landed costs, supplier
  locked rates, Freight, Other Charges, Duty, Commission and amount sharing
  are handled by their established services. This audit does **not**
  override those calculations.
- No recalculation of historic per-container supplier Inside/Outside balances,
  no posting of tentative customer freight, no duplicate reclassification of
  Factory and ERP bale mirror inventory.
- Factory accounting modes remain separate from Supplier Partner inventory
  and the ERP Goods in Transit/stock-in mechanics added in Phase 6.
- No automatic daily GL-FACTORY-STOCK posting activation.
- No new system account or table is necessary: this is read-only and uses
  existing accounting structures.

## Claude certification — unexecuted here

For independent signoff, Claude should verify:

1. SQL types, joins, tenant RLS and privacy/role access.
2. Current-day vs historic reporting semantics, including changes to
   deleted/edited records and 200-row truncation.
3. Multiple Factory container receipts with successive fixed rates,
   varying freight/commission/duty currencies and optional reversal.
4. No receipt recorded yet for OTW or partially received containers.
5. Supplier-locked material USD rate, mix cost propagation, pressing yield,
   zero-cost garbage and unvalued bales.
6. Daily stock journal events, variance account categorization and date locks,
   without invoking a financial posting.
7. Early nonfinalized charge vouchers flagged and legitimate finalization
   charge vouchers not double-counted.
8. Foreign-currency invoice native amount evidence and missing FX refusal.
9. Finalized invoice receivable, sales income, and bales' COGS after the
   **existing, separate perpetual cutover gate**. Verify zero-amount, missing
   rate and legacy charge link cases.
10. ERP bale mirror exclusion and customer statement integrity.
11. Frontend routes and Reports display under ERP and Factory.
12. Independently reconcile actual company data, but **do not mutate
    production vouchers or stock** as part of this handoff.

**No tests, CI, compile, certification, merge, rebase, production voucher
modification or Render deployment was performed in this phase.**
