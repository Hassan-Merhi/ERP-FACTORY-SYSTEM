# Factory Mix Cost Integrity — Phase 5: downstream bale & GL reconciliation

**Date:** 2026-11-09 (Beirut).  
**Branch:** `fix/factory-mix-cost-integrity-20261109`, alongside Phases 1–4.  
**Code:** Implemented and committed. **Database inspection:** read-only on company 12.  
**TablePlus/migrations:** None. **Historical record changes:** None.  
**CI/tests:** Regression tests committed but not executed, consistent with the owner's earlier no-CI instruction.  
**Merge/deployment:** Not performed; the feature branch has diverged from `main`.

## Key production discovery

At the latest read-only inspection of company 12:

| Evidence | Result |
| --- | ---: |
| Active mix batches | 222 |
| Completed mix batches with recorded used kg | 222 |
| Mix batches with direct bale linkage | 0 |
| Mix batches with pressing-batch linkage | 0 |
| Mix batches with daily-usage linkage | 0 |
| Factory bales without a deletion timestamp | 47,452 (this count changed from 47,448 during audit; production is live) |
| Bales with `mix_batch_id` | 0 |
| Bales linked indirectly via a pressing batch with a mix | 0 |
| Bales marked SOLD | 40,116 |
| Bales marked DISPATCHED | 353 |
| Bales marked IN_STOCK | 4,880 |
| Recorded available stock value (selected inventory statuses) | $208,887.00 |
| Distinct bales on customer orders | 42,664 |
| Bales on invoice-loading records | 2 |
| Historical reviewed bale recost runs | 2, both with no linked voucher |
| Historical replay undo logs | 2 |
| Active perpetual inventory cutover | None |
| Factory stock valuation events | 0 |

**Interpretation:** The historical mix and bale records are individually present but their cost-flow relationship is unrecorded. Historical batches with used kg cannot be cost-cascaded to finished goods, COGS or sold bales from these tables alone. This is a provenance problem, *not* proof the saved bale rates are zero/incorrect or that all sold bales need recosting. A linked-bale mismatch count of zero is vacuous when no bales are linked.

The absence of an active `gl_inventory_cutovers` row explains why an automatic present-day perpetual-inventory journal should not be fabricated. Older accounting may use periodic methods; do not post a speculative balance correction.

## Implemented

### 1. Read-only downstream reconciliation

`server/services/factory/mixPhase5DownstreamAudit.ts` evaluates **every** saved mix (active and deleted), direct and pressing-linked bales, daily usages, rates and totals of any *actually linked* bales, saved FINISHED STOCK amounts, sold/dispatched exposure, customer-order and invoice-loading coverage, prior recost runs, replay undo records, and perpetual cutover state. It uses one tenant-scoped `REPEATABLE READ READ ONLY` PostgreSQL transaction. No lazy backfills, no re-pricing, no vouchers and no inferred links.

**Factory Mode:** `Audit Bale & GL` button and downloadable per-batch `Bale/GL CSV`, next to the existing historical audit controls. Admin/Owner/Developer only.

**Endpoint:**
- `GET /api/factory/mix-batches?profile=downstream-audit`
- `GET /api/factory/mix-batches?profile=downstream-audit&format=csv`

No new route path, permission manifest or migrations.

### 2. Historical Replay preflight and apply guard

`server/services/factory/historical-replay/downstreamGatePhase5.ts` validates the **specific signed write scope**, not all unrelated Factory batches. Before allowing any future historical source/batch/bale cost write, it rejects:

- A corrected batch with **used kg and no directly linked bale records**. A pressing sheet or daily usage alone is insufficient proof of the bale-specific cost basis; bona fide waste must be resolved through a separate reviewed process.
- Any scope that would impact **finalized, sold, dispatched, invoiced, POS-sold, or sale-ledger-posted bales**, including frozen invoice documents. `factory_bales.finalized_at` alone is *not* used to identify a sale, since physically pressed IN_STOCK bales can have that timestamp.
- **An active perpetual inventory cutover** if the replay would write valuation rows (including supplier locked rates), because the existing cost-only replay has no matching atomic GL revaluation journal. The already existing reviewed `baleRecost` workflow posts to Factory WIP, Finished Goods and Revaluation under perpetual cutover, after its own open-period check. It must not be replaced by cost-only replay.

**Safety integration:** The existing Prepare endpoint checks these flags and omits the confirmation token when blocked; the separate post-offload Phase 6 readiness also advertises the blocker. Most importantly, `applyExactHistoricalCostReplayV6` re-checks this gate in its **SERIALIZABLE database transaction before consuming the one-use token or changing a single source/bale/supplier rate**, so a saved token or alternate caller cannot bypass this protection. New violations return HTTP 409 (`HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED`) through the V4 route.

These protections are intentionally strict; they will not automatically remove a batch's historical cost nor silently skip downstream finished goods to make a replay appear successful.

### 3. Tests

`tests/factory-mix-phase5-downstream.test.ts` covers:
- Missing lineage is blocked, *not* reported as a clean cost reconciliation;
- Deleted/unused/linked-bale mismatches classified separately;
- Sold and in-stock amounts kept distinct, no invented COGS delta;
- Formula-safe CSV for Excel;
- Read-only transaction and rollback;
- Replay scope guard refusal on orphaned production, finalized sales, and a live perpetual GL cutover;
- Previously pressed IN_STOCK bale not mistaken for a sold bale merely because `finalized_at` is set.

## Correction policy / release boundaries

**No historical cost correction has yet been applied** because the source evidence needed to map consumed mixes to individual bales is absent from the live tables. Before a future approved correction:

1. Obtain dated original pressing sheets, work orders, stock-entry source references and bale allocations, establishing a unique mix→production→bale path.
2. Reconcile the batch's source USD and weighted rate; verify that each proposed change affects only the traceable production cohort.
3. Identify available unsold stock separately from finalized/ordered/invoiced/sold bales; never mutate posted COGS or a closed accounting period through mix replay.
4. Preview the complete per-bale and WIP delta. Apply only with a new signed scope and revalidated transaction snapshot; if perpetual GL is active, use an **atomic journal-posting** workflow.
5. Verify source, mix, bale, inventory valuation, period and GL balances after any approved operation, and retain the undo/audit history.

**Next:** Phase 6 covers completion/carry-forward quantity lifecycle. Phase 7 adds recurring diagnostics; Phase 8 covers tests, resolving upstream main divergence, and release/deployment after approval.
