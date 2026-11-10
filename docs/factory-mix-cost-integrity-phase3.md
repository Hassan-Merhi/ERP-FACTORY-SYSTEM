# Factory Mix Batch Cost Integrity — Phase 3 (historical reconciliation)

Date: 2026-11-09 (Asia/Beirut)  
Branch: `fix/factory-mix-cost-integrity-20261109` (same Phase 1/2 branch)  
Status: **Phase 3 implementation committed; production data examined read-only**.  
No migrations, SQL to run, automatic costing repairs, vouchers, merges or deployments.  
Owner requested no CI during development; tests are committed but not executed.

## Scope and safety

Phase 3 performs a consistent, read-only historical reconciliation of **every** saved Factory mix batch, including deleted batches. It does NOT infer historical value from today's supplier rate. The recorded source rate and total USD constitute the stored snapshot; independent reconstruction of the rate *at the original transaction date* requires reliable provenance and the existing Historical Replay engine.

The following are **different** concepts:

- Stored source cost and batch header disagreement: an arithmetic/integrity anomaly.
- Stored source rate vs today's supplier locked rate: **informational**, not evidence that the original price was wrong.
- Stored source rate is zero: genuine historical unvalued data, requiring dated source/FX evidence, not an automatic nonzero overwrite.
- Container ownership or original offload after the batch business date: provenance anomaly; may reflect legacy migration/backdating and cannot alone justify a price correction.
- Missing or unclassified old valued ADD adjustment: requires dated adjustment valuation evidence; does not independently prove wrong cost.

### Actual read-only production audit (company 12, 9 November 2026)

| Observation | Count | Meaning |
| --- | ---: | --- |
| Total batches | 229 | 222 active + 7 deleted |
| Source rows (all batches) | 1,086 | Saved historical source rows |
| Active header vs source weight differences > 0.01 kg | 0 | No quantity-header correction established |
| Active header vs source cost differences > $0.02 | 0 | No cost-header correction established |
| Active header blended-rate discrepancies > $0.0001/kg | 0 | Recorded blended arithmetic reconciles |
| Source line math differences > $0.02 | 0 | Max raw difference only $0.00000032 |
| Old Edit-window recalculation differences > $1 | 210 | **Not** historical mistakes; old preview treated missing current rate as zero |
| Active batches lacking a current supplier rate | 24 | Modern prospective price unavailable; keep saved historical rate |
| Inventory-supplier attribution review | 23 batches / 31 source rows | Phase 4 ownership reconciliation |
| Historical source with zero recorded rate/cost | 1 batch | FMB-2026-0051, 10,725 kg, source ID 222 |
| Batches affected by an unclassified earlier valued ADD adjustment | 100 | 9 distinct qualifying adjustment rows, potential shared supplier provenance |
| Stock offload currently dated later than mix date | 40 batches / 121 source rows | Timeline evidence review; not proof of an incorrect rate |
| Batch used kg > total kg | 3 | Quantity lifecycle Phase 6 |
| Completed batches with remaining kg | 27 | Completion/carry-forward Phase 6 |

The 210-count is a reproduction of the **old** preview behavior, including 24 cases where missing current supplier rate was read as $0. The new audit returns **no current-rate estimate** for batches missing the required modern rate, so its current-rate preview difference count can be smaller and is more meaningful.

### Confirmed production corrections during Phase 3

**None.** The active saved source totals, weights and batch headers reconcile at the selected tolerances. Therefore, no objectively supported arithmetic cost correction is available to apply safely. An unsupported blanket recost would damage historical valuations. This is a positive reconciliation result, not permission to skip the outstanding evidence work.

## Implemented code

- `server/services/factory/historicalMixBatchReconciliation.ts`: one company-scoped, **REPEATABLE READ READ ONLY** database snapshot; reconstruct source and batch arithmetic with Decimal, inspect suppliers, containers, upstream mix links, valuation-basis adjustments, deleted records, unvalued sources and current-rate drift. Contains no DML or repair endpoint.
- `GET /api/factory/mix-batches?profile=historical-audit`: admin/owner/developer-only JSON report; add `&includeSources=false` for a lighter list.
- `GET /api/factory/mix-batches?profile=historical-audit&format=csv&level=batches`: all-batch CSV including deleted cohorts and issue classifications.
- `GET /api/factory/mix-batches?profile=historical-audit&format=csv&level=sources`: source-level CSV with recorded historical USD, current-rate **comparison** (not a repair target), current ownership and adjustment evidence.
- `client/src/pages/factory/production-raw-stock/MixBatchList.tsx`: privileged Factory Mode "Audit All Batches", audit snapshot and full CSV exports.
- `tests/historical-mix-batch-reconciliation-phase3.test.ts`: regression cases for historical vs current rates, missing modern supplier prices, zero-cost sources, line/header math, ownership, timeline, adjustments, deleted cohorts, CSV injection prevention, read-only transactions and rollback on failure.

No new route path is introduced: the historical audit uses the existing authenticated mix-batches GET profile. No route manifest changes or database migration are required.

## Correction approval and boundaries

1. Record the original business date, supplier inventory-owner, container/adjustment rate provenance, historical FX and linked downstream batches/bales.
2. Use the existing Historical Replay **preview** to derive expected original USD rates where its provenance and scope are complete. Treat unresolved or ambiguous records as blocked/manual review.
3. Review suggested scope, historical source and batch deltas, affected available/finalized bales, GL period effects and rollback plan.
4. Only then apply the controlled historical correction through the existing reviewed replay mechanism, once applicable Phase 4/5 safeguards are completed and owner approves the exact change.
5. Re-run this Phase 3 report before and after correction. Never silently change a completed cost or generate duplicate vouchers.

## Next work

- **Phase 4:** supplier/container/FX provenance, unclassified adjustments, raw-material quantity and negative-stock reconciliation.
- **Phase 5:** downstream bale valuation and accounting-period correctness for any proposed cost repair.
- **Phase 6:** overused, completed and carry-forward quantity lifecycle.
- **Phases 7–8:** ongoing diagnostics, full testing, convergence with main and release.

Note: the feature branch has diverged from main due to concurrent development; resolve that during final integration, not through an unreviewed force-merge.
