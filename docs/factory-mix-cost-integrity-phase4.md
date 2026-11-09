# Factory Mix Batch Cost Integrity — Phase 4

**Branch:** `fix/factory-mix-cost-integrity-20261109` (same Phases 1–3 branch)  
**Scope:** Supplier/container ownership evidence, supplier ADD-backed stock, historical adjustment valuation basis, physical FIFO provenance.  
**Code:** Implemented and committed. **Live data audit:** Read-only.  
**Database migrations / TablePlus SQL:** None. **Historical data writes:** None.  
**CI/test execution:** Tests added, deliberately not run (owner requested CI later).  
**Merge/Render deployment:** Not performed; pending remaining phases and integration.

## 1. Verified production evidence — company 12, 9 November 2026

- **222 active mixes**, **7 deleted**, **1,086 recorded source rows**.
- **31** active source rows in **23** mix batches show a difference between saved pricing/inventory supplier **MODA ZAKARIA DIRECT (#37)** and the container's *current* supplier **CYPRUS MODA (#60)**. This may be a transfer/change of ownership, not necessarily corruption. The historical ownership at each batch date has not been independently proven. Do **not** replace `supplier_id`, `inventory_supplier_id`, or historical USD values in bulk.
- **3** raw-container receipt rows have used kg greater than their own received kg, totaling **25,903 kg**, *exactly equal* to the corresponding suppliers' recorded **ADD** adjustment quantities:
  - **BANIN (#34)**: receipt-row excess **19,624 kg**, ADD total **19,624 kg**.
  - **GERMANY (#26)**: excess **3,516 kg**, ADD total **3,516 kg**.
  - **SPAIN MANSOUR (#31)**: excess **2,763 kg**, ADD total **2,763 kg**.
- **9** valued supplier ADD adjustments still have no `valuation_basis`. One, **ID 15** (SPAIN MANSOUR), is denominated **EUR**, with an existing note about a transfer. This must not be represented as an authoritative USD valuation without confirmed historical FX.
- The three matching ADD totals explain why simply forbidding *any* container-row overdraw would have blocked valid supplier-level adjustments. Aggregate coverage is **not** proof that quantities were available on the precise historical date or allocated to the correct original container.
- The Phase 3 zero-cost source **FMB-2026-0051** still requires original basis/FX proof. Phase 4 intentionally does not invent its rate.

## 2. Implemented prevention logic

**Create mix / Top up mix**
- Supplier FIFO consumption now checks available actual container-row kg and the *remaining* supplier ADD quantity, rather than allowing unlimited overdraw on the last FIFO container.
- Available ADD backing = recorded supplier ADD quantity minus existing receipt-row excess, with conservative deduction for legacy supplier-only source rows that lack provable container attribution. The existing supplier row is transactionally locked before allocating.
- When an unused supplier ADD genuinely covers a FIFO remainder, the system permits that supplier-level consumption and records the extra segment separately with `source_type = SUPPLIER_ADJUSTMENT_BACKED` and an explanatory source note.
- A proposed physical container-direct source can consume only the specific container's available kg; it may not claim unspecified supplier ADD inventory.
- If supplier receipts plus unused ADD cannot cover a proposed mix, the whole transaction is rejected with HTTP 409, `MIX_RAW_STOCK_SHORTAGE`; no raw-stock, source, batch, or valuation writes are committed.
- New supplier FIFO **top-ups save one source record per actual container/adjustment-backed segment**, rather than a single unallocated supplier record. This preserves reverse-allocation provenance for future edits and deletion.
- Supplier rows are locked before allocation to prevent two concurrent mix operations spending the same ADD pool.
- Existing 25,903 kg in historical receipt-row overdraws are **not** erased, clamped, treated as confirmed shortages, or rewritten.

**Historical adjustment classification**
- The existing Admin/Owner/Developer Historical Replay adjustment-valuation classification endpoint now requires an explicit **20–1000-character documentary evidence explanation**, saved with the audit before/after.
- Its existing safeguard rejects non-USD `VALUED_TRANSFER` and `OPENING_BALANCE` without explicitly stored authoritative USD cost. `QUANTITY_ONLY` is not a zero-cost repair; it is a classification requiring evidence.
- The existing Historical Replay Safety Panel now collects an evidence statement for each adjustment before enabling classification.

## 3. Phase 4 audit and exports

New privileged, read-only profile on the existing mix-batches GET endpoint:

```
GET /api/factory/mix-batches?profile=raw-provenance-audit
GET /api/factory/mix-batches?profile=raw-provenance-audit&format=csv&section=stock
GET /api/factory/mix-batches?profile=raw-provenance-audit&format=csv&section=ownership
GET /api/factory/mix-batches?profile=raw-provenance-audit&format=csv&section=adjustments
```

Admin/Owner/Developer only. Runs a tenant-scoped PostgreSQL `REPEATABLE READ READ ONLY` snapshot; returns the underlying recorded supplier/container values, per-supplier net stock, possible ADD backing, unclassified valued adjustments, and review classifications. CSV cells are protected against spreadsheet-formula execution. Factory Mode Mix Batch list now has an **Audit Raw Stock** action and three CSV exports.

## 4. Not authorized / not automatically corrected

- The **31 historical ownership differences**: changing `inventory_supplier_id` is withheld until historical purchase/transfer documents establish which company supplier owned that container when the mix consumed it. Today's `factory_containers.supplier_id` is not necessarily historical truth. Updating it without evidence can corrupt supplier ledgers and historical replay scope.
- The **9 historical adjustment valuation classifications**: require the operator to review original documentary evidence and explicitly classify one at a time. No mass assignment to `QUANTITY_ONLY`.
- The **3 adjustment-backed overdraws**: do not increase receipt `received_kg`, fabricate offloads, or create replacement accounting vouchers. They need a dated supplier event/adjustment reconciliation before historical stock structure is changed.
- The **EUR addition**: do not use its non-USD cost per kg as USD, nor assume FX = 1.
- The **zero-cost historical mix source**: cannot be priced from the supplier's current rate.

## 5. Regression coverage added

- `tests/factory-mix-phase4-provenance.test.ts`: ADD-backed vs unbacked quantity classification, exact balances, raw/ownership/FX classifications, CSV safety, manual ADD pool use and precise refusal.
- `tests/factory-historical-replay-v7-final-safety.test.ts`: documentary evidence required for valued adjustment classification.
- Phase 1–3 tests remain on the branch. Tests/CI were intentionally not run during this phase.

## 6. Next steps and release dependency

Phase 4 source provenance and prevention code is committed. Historical exceptions remain explicitly pending independently verified source evidence, not a guessed repair. Phase 5 must reconcile downstream bale and GL valuations for any subsequent approved repair; Phase 6 handles quantity completion/carry-forward; Phase 7 adds recurring integrity checks; Phase 8 includes full tests, branch integration with a fast-moving `main`, and deployment after owner approval.
