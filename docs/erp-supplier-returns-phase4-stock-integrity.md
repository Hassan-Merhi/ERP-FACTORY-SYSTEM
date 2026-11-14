# Supplier Returns — Phase 4 stock-posting integrity

Date: 2026-11-14
Branch: `feature/erp-supplier-returns-multi-container-average-cost`

## Implemented
- Supplier Returns page transmits the requested Excel/manual rows alongside its aggregated per-offload commit lines. Original request quantity and exact user-edited source allocations are included.
- New `validateReturnCommitRows` rejects missing/invalid allocations, duplicate sources in a row, over/under allocation, invalid decimal quantities and mismatched commit lines **before starting the stock transaction**.
- Commit rechecks every posted offload source against the row's article code (including configured aliases), and does not allow mixed suppliers **within one imported row**.
- Existing commit still locks source offload rows in sorted ID order and checks each remaining source quantity within the transaction.
- Aggregated stock demand per company/location/item is checked under `FOR UPDATE`; shared buckets now lock in numeric location/item order to reduce deadlock risk.
- The existing `postStockMovementTx` writes one canonical issue per audited supplier-return source, while `adjustInventory` is the **only** actual inventory quantity/value change. Added checks for the exact quantity decrement and persisted inventory book-value delta returned by `adjustInventory`; any mismatch throws and rolls back the entire transaction.
- Existing audited return lines, supplier vouchers, movement evidence and batch totals remain committed atomically. A server-side check verifies the final total equals the original requested quantity before the batch record is finalized.
- Existing idempotency request-key lock and return-source locking retained.

## Regression tests committed
`server/routes/erpSupplierReturnCommitValidation.test.ts` includes:
- exact 17+1 split;
- duplicate input article rows aggregating to one source;
- incomplete/overallocated row;
- wrong posting source/quantity;
- duplicate source IDs;
- invalid/zero/over-precision quantities and invalid source IDs;
- missing allocation/article;
- input immutability.

## Verification boundary
- Code and tests committed; no production writes, migration, merge, or deploy.
- No GitHub workflow run or commit status was returned for the Phase 4 head at review time.
- Unit tests were **not executed** in this connector-only session, so CI/typecheck success is not claimed.
- End-to-end database rollback/concurrency, inventory GL reconciliation, last-unit valuation, and live stock validation still require database-backed verification (Phases 5 and 7).

## Important compatibility
The new `requestedRows` field is optional on the server to avoid breaking existing clients that only submit per-offload `lines`. The upgraded page always sends it; it is validated before posting. Older clients continue through the existing source/inventory constraints, but cannot carry a multi-container Excel-row relationship.

## Next
Phase 5: supplier credit, source purchase rates, moving-average stock value and rounding/variance reconciliation.
