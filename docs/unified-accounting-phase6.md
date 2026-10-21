# Unified Accounting — Phase 6: ERP Inventory and Cost of Goods Sold

**Branch:** `feature/unified-accounting-erp-factory-rentals` (shared Phases 1–6)  
**Scope:** ERP inventory, sales COGS, purchases, Goods in Transit, ERP stock receipts/offloads, stock adjustments, transfers, returns and historical cost protection.

**Implementation status:** Phase 6 code committed. **No CI, automated tests, compilation, database test, merge, deployment, production voucher, stock adjustment, or historical repair was executed**. Claude independently certifies the branch, as requested by the owner.

## Existing posting services reused rather than replaced

The ERP already has sophisticated cost movement services. Phase 6 does **not**
create a second posting engine, replace their journal numbers or revalue
history:

| ERP event | Existing accounting behavior | Existing source |
|---|---|---|
| Sales/Receipt with stock relief | `COGS-{saleVoucherId}`: debit cost of goods sold, credit Inventory at actual value relieved by the stock subledger | `perpetualInventory/saleCogs.ts` |
| Purchase order on the way | `GIT-PO-{purchaseOrderId}`: debit Goods in Transit, credit Purchases by posted PO purchase cost | `perpetualInventory/stockReceipts.ts` |
| Container offload | `STOCK-IN-{containerId}-{offloadId}`: debit Inventory at the recorded stock-receipt value, credit Goods in Transit/charge accounts, balance landed-cost/shortage variance against appropriate accounts | `perpetualInventory/stockReceipts.ts` |
| Inventory quick adjustment, cost correction and other value changes | `INV-MOVE-{companyId}-{sourceType}-{sourceId}`: Inventory against the configured system offset, with dated `inventory_value_movements` evidence | `perpetualInventory/inventoryMovementJournal.ts` |
| Stock transfer | Inventory value conserved between locations; only documented shortage settlement can create an INV-MOVE variance into COGS | `inventory/conservedStockTransfer.ts` |
| Credit note (returned item) | Inventory restored at recorded cost; original voucher's stock movement and any COGS variance are recorded on the credit note | `inventory/creditNoteInventory.ts`, `creditNoteRoutes.ts` |
| Debit note (additional stock issue) | Inventory removed at stock cost, with revaluation variance where the document cost differs | `inventory/creditNoteInventory.ts`, `creditNoteRoutes.ts` |
| Reversal/edit/delete | Source-owned voucher lifecycle and recorded `value_moved`/original relief value; restore exact stock value rather than pricing from today's average | Existing voucher retirement, credit note and value-exact reversal services |

Source document and GL posting logic remain transactional and idempotent
through the existing service boundaries. All ERP inventory remains valued at
**recorded cost**; no selling-price valuation enters GAAP inventory/COGS.

## Phase 6 implementation

### 1. Read-only ERP source-to-ledger accounting audit

New: `server/services/accounting/perpetualInventory/erpInventoryAccountingAudit.ts`.

The report traces the latest 250 source documents of each type within the
selected ERP company and date:

- Sales/Receipt with stock-item lines → expected `COGS-{saleId}` journal,
  source voucher date and live Inventory credit.
- Purchase orders linked to live vouchers → source Purchases debit,
  `GIT-PO-{poId}`, live Goods in Transit debit, and original accounting date.
- Active container offloads → recorded `container_offload_items.value_moved`
  (or legacy stored source value), `STOCK-IN-{containerId}-{offloadId}`,
  Inventory debit and source offload date.
- Every dated inventory value movement source → recorded signed
  `inventory_value_movements.value_delta`, stable `INV-MOVE` journal
  and matching signed Inventory movement.
- Credit/debit notes → stored `credit_note_items.value_moved` (fallback to
  its saved quantity × inventory cost for legacy rows), compared with
  the Inventory debit/credit on the **same** note voucher.
- Inter-location stock transfers → operational stock-applied status.
  **No extra consolidated COGS** journal is expected for a conserved transfer;
  any documented shortage-settlement adjustment is audited as its
  separate INV-MOVE record.

Each live journal is located by the owning company, deterministic voucher
number, `deleted_at IS NULL`, and `optional=false`; retired generations
cannot pass as active. Journal business dates are compared with source dates
and financial amount differences use decimal arithmetic at the cent level.

Statuses: `posted`, `missing`, `cost_mismatch`, `date_mismatch`,
`expected_periodic`, `review`. A missing sale COGS journal is marked
`review` when the original stock-relief value is no longer reconstructable
from source data, **not** automatically assigned a guessed charge. Missing
journals before the cutover are **expected periodic behavior**, not missing
posting errors.

This is an audit, **not a historical replay or an automatic repair**. It
lists all returned records with their source reference and expected journal
number. If one source type reaches the 250-row cap, the response clearly
marks the report as truncated instead of implying all history was reviewed.

### 2. Valuation and readiness

The audit reports ERP stock at recorded cost using the **existing**
`companyStockValuation` / `companyStockValuationAsOf` functions; valuation
excludes Factory bale mirrors and incorporates the existing negative-stock
policy. For companies with an applied perpetual cutover, the same date's
`INVENTORY` account book value (debit positive) and difference are shown
for review. For a periodic company, there is **no false assertion** that the
periodic Inventory GL should equal the operational stock.

The cutover readiness endpoint calls the existing
`perpetualReadinessReport`. That report already lists orphaned and
anomalous stock, unvalued factory stock/bales, legacy FX problems, unposted
factory invoices, stock import exceptions, documents crossing cutover,
and ledger differences. It is not duplicated or weakened here.

**Critical control:**
`PERPETUAL_INVENTORY_POSTING_READY` in `cutover.ts` remains `false`.
No automatic startup cutover, new opening voucher or mass historical rewrite
is part of Phase 6. Activating it before independent certification of all
ERP/Factory posting paths could contaminate live inventory and GL.
Only the existing explicitly authorized cutover procedure may activate
perpetual accounting once the owner and Claude have validated its readiness.

### 3. Fail closed on account code/type conflicts

The common perpetual journal account lookup
`perpetualInventory/linkedJournal.ts` previously accepted some
`ensureSystemAccounts` statuses that meant the expected account had
**a different code or type**. Phase 6 requires `ok` or `created` for each
required system account. It rejects `type_differs`, `reused_by_name`,
`deleted`, and `missing` before posting. The special INVENTORY
asset-account control guard remains handled by the existing stricter
`getOrCreateInventoryControlAccount`.

This prevents source-derived COGS/Inventory/GIT journals from being silently
posted into unrelated, accidentally named or retyped accounts.

## API and UI

New read-only routes:

- `GET /api/accounting/erp-inventory/audit?asOfDate=YYYY-MM-DD`
- `GET /api/accounting/erp-inventory/readiness?effectiveFrom=YYYY-MM-DD`

Both get the authenticated session company, require Admin/Owner/Developer,
and share the project's transaction company-scope enforcement. No body
parameters can select another company or trigger a stock write.

ERP page: **`/accounting/erp-inventory`**

New UI `client/src/pages/ErpInventoryAccounting.tsx` provides:
- accounting mode (Periodic, Perpetual or Supplier Partner), applied cutover
  date, posting-ready flag;
- the existing cutover readiness blockers;
- stock at recorded cost vs. Inventory GL where meaningful;
- filters for source type and status;
- links to existing live source accounting journals;
- explicit read-only and historical evidence limitations.

It is linked under ERP Accounting navigation using the existing
`accounts` ERP permission; no new unrestricted permission key is added.

## What this implementation does NOT do

- Does not turn on the existing global perpetual inventory posting-ready
  switch or apply the opening journal.
- Does not manufacture or amend `COGS-*`, `GIT-PO-*`,
  `STOCK-IN-*`, `INV-MOVE-*`, credit notes or transfer vouchers.
- Does not change stock quantities, production costs, landed charges,
  negative-stock cost basis, sold quantities, FX rates or original invoice
  amounts.
- Does not alter historical pre-cutover periodic statements.
- Does not rewrite Factory Raw/WIP/Finished Goods or Supplier Partner stock:
  the Factory-specific enhancements belong to Phase 7.
- Does not certify historical valuation where retired documents, missing
  original value evidence or current factory cost overwrites prevent a
  true past-date reconstruction; Phase 10 owns that capability.

## Claude handoff: certify, do not blindly apply cutover

At minimum Claude should independently validate:

1. TypeScript types/routes/UI compilation and authorization.
2. Each audit query's column names, tenant scoping, debit/credit sign,
   effective dates, and pagination cap.
3. Sale COGS cost relief on negative stock and zero-cost sales, same-day
   separate journal date, edit/reversal/return.
4. PO GIT and partial offloads with distinct per-offload journals, landed
   charges and shortage variance.
5. Credit and debit notes with `value_moved`, including old nullable
   values; conservation of transfer value and shortage residual INV-MOVE.
6. Company accounting-mode transitions and the existing cutover gate
   **remaining off until certification**.
7. Required control account type/name conflicts fail before any posting.
8. Cost-based stock GL reconciliation versus current/as-of stock subledger.
9. Supplier Partner and Factory bale mirror exclusions, original FX and
   historical sales/expenses unaffected.
10. No production migrations, vouchers, cutover or balance repairs from this
    feature branch until explicitly approved.

**Phase 6 implementation is committed but not independently tested,
certified, merged or deployed.**
