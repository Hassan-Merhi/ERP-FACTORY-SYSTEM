# Historical sales COGS repair — stock-transfer revision findings

Status: research only. No repair-algorithm change. APPLY stays disabled.
Date: 2026-10-01. Baseline: dry-run #33, `2026-09-30-v30-wave6-valuation-reset`
(72,755 rows, 30,811 changed, 21,900 blocked, 1,139 blocked keys).

## Why this note exists

The V27 handoff proposed a replay of transfer revisions: emit the reconstructed
original quantity at the transfer's creation time, then emit each approved
revision's `delta` at `revision_date`. Production data and code history show that
this model doesn't match how pre-canonical transfers changed inventory.
Implementing it as written would invent movements, which breaks the fail-closed
rule.

## How large the lead is

In run #33, blocked checks whose boundary is a legacy transfer movement:

| boundary on            | COST_MEMORY_IRREVERSIBLE | MOVEMENT_INVERSE_INVALID |
|------------------------|-------------------------:|-------------------------:|
| revised transfer       | 2,116 (138 boundaries)   | 803 (36 boundaries)      |
| non-revised transfer   | 662 (62 boundaries)      | 521 (14 boundaries)      |

Revised transfers are still the biggest transfer-related cluster.

## What really happened to pre-canonical revised transfers

1. **Every revised transfer has a later full-replace save.** For all of them, every
   `stock_transfer_items` row has the same `created_at`, and it is after the last
   revision (often by 1–2 days). The old `PUT /api/stock-transfers/:id`
   (`storage.updateStockTransfer`) reversed every old line, deleted all lines,
   re-inserted them, and re-applied them. So the loader's
   `GREATEST(sti.created_at, …)` is the **last save time**. It is not the
   creation time.

2. **Most were optional drafts.** From May to July, 39 of 48 revised pre-canonical
   transfers that have voucher audit rows flipped `optional: true → false` *after*
   their first revision. 29 flipped at or after their last revision. Draft PUTs
   skip inventory (`isOptional`), so **draft-era revisions never moved stock**.
   Inventory was first applied by `PATCH /api/vouchers/:id` at finalization
   (`!willBeOptional && !inventoryApplied`: source issue at the running average,
   destination receipt at `item.rate`). Flipping a voucher back to optional
   reversed it. April has no voucher audit rows, so finalization can't be
   observed there.

3. **At least four mutation semantics existed for revisions:**
   - draft revisions: record only, no inventory effect;
   - admin "Save as Revision" on a finalized transfer: client PATCH voucher →
     full PUT (source receipt of each old line at its old stored rate,
     destination issue at the running average; then source issue at the average,
     destination receipt at the new rate) → POST revision record;
   - POS `optional=true` revisions (present by mid-May): record only until an
     admin approved them, then the **net delta** was applied with
     `adjustInventory`. The approval time was **not stored**. `revision_date` is
     the submission time. Migration 011 later relabelled these as
     `status='approved'` with `reviewed_at IS NULL`, so they look identical to
     admin revisions;
   - August lifecycle (`reviewed_at` set): delta applied at approval. Since
     2026-08-17, `journalStockTransferLeg` journals it canonically as
     `stock-transfer` / `source_id = transferId`.

4. **The evidence has gaps:**
   - plain saves (PUT with no revision row) changed quantities without a record;
   - `DELETE /api/stock-transfer-revisions/:id` (added 2026-04-11) deleted
     revision rows without touching inventory;
   - migration 011 renumbered `revision_number` sequentially, which hides gaps
     from deleted revisions;
   - revision items carry no `rate`.

   The voucher audit (`audit_log`, `table_name='vouchers'`, from about July)
   timestamps every client save, because the client PATCHes the voucher before
   each PUT. Even so, it can't separate saves from other voucher edits, and it
   can't recover the quantities of plain saves.

5. **Rates.** The April–July client preloaded each existing line's stored rate and
   kept it across edits. New lines took the source location's rate when they were
   added, and there was no rate input. This suggests that a line which survives to
   the final row kept `final rate` throughout. That hasn't been verified for every
   client version, and it says nothing about lines that were removed.

## Consequences

- The handoff's "original quantity at creation + delta at `revision_date`" model is
  wrong for drafts, which are most cases, and for POS-approved revisions, where the
  timestamp is wrong. It would add phantom destination stock before finalization.
- The current loader, which puts the final quantity at the last save, is roughly
  right when finalization happened at the last save. It is wrong when saves
  happened after finalization. In that window the true quantities were the
  finalization-time quantities, followed by full reverse and reapply at each
  later save.
- Because of the gaps above, the intermediate quantities are **not provable in
  general**. They can only be proven for transfers where every save after
  finalization is accounted for.

## Proposed safe path

1. Classify each pre-canonical revised transfer from immutable evidence: draft
   window (voucher audit optional flips), finalization time, saves after
   finalization (voucher audit rows), and admin versus POS revision (`created_by`,
   with save timestamps matching to the millisecond, since the client's PATCH
   comes right before the revision row).
2. Build a candidate lifecycle only for transfers where:
   - finalization is observed;
   - every save after finalization pairs with a revision row (or is shown to be
     quantity-neutral);
   - the quantity chain reconciles: `original_quantity` equals the prior
     `new_quantity`, and the last `new_quantity` equals the final row's quantity;
   - no removed line needs an unknown rate.

   Model the candidate as: apply at finalization, then a full reverse and reapply
   at each later save, using the engine's existing receipt and issue semantics.
3. Use the candidate **only** as an alternative in the opening-forward proof, the
   same way `pos-sale-normalized` is used. Accept it only when it reproduces the
   immutable Phase 3 checkpoint exactly. Everything else stays blocked. Suggested
   blocker codes: `LEGACY_TRANSFER_REVISION_TIMESTAMP_AMBIGUOUS` (POS approvals,
   April), `LEGACY_TRANSFER_REVISION_CHAIN_INVALID`,
   `LEGACY_TRANSFER_REVISION_RATE_EVIDENCE_MISSING`,
   `LEGACY_TRANSFER_UNRECORDED_SAVE`.
4. Before step 2, check the `updateStockTransfer`, voucher PATCH, and POS approval
   code at every deploy between 2026-04-10 and 2026-08-17. The reversal guard
   `inventoryApplied || !isOptional` and the finalize path changed during that
   period (for example `398244eb3`, 2026-07-23, and Phase 7 `2e2fc03eb`,
   2026-07-22).

## Side lead

The legacy transfer `NOT EXISTS` excludes a legacy leg whenever *any* canonical
`stock-transfer` row exists for the same transfer, item, and location. Only one
pre-canonical revised transfer (770, created 2026-08-12, last saved in the
canonical era) is affected. Check whether its pre-canonical application is
missing from the replay.

## Rewind divergence: company 1, location 134, item 702 (runs #33–#36)

- Every historical sale at this location stores cost_price 107.34. That is the
  locked live rate of canonical sale 13471 on 2026-09-04, stamped onto older
  sales. This is the corruption the repair exists to fix.
- Stock never reaches zero. Starting from the item opening of 1 @ 92.11, it hovers
  at 1–5 units and returns to exactly 1 unit dozens of times from January to
  September. Because there is no reset, the checkpoint rewind must cross every
  receipt. Each rewound receipt multiplies the reconstructed rate's sensitivity
  to any value error by Q_after/Q_before (often 2–6×). A 2-cent drift became
  110 → 157 → 471 → 6,031 → … → 536,372,383.50/unit by January. Every local
  inverse step still replayed exactly, so only the V32 evidenced-rate-range
  guard caught it.
- A forward replay from the opening is stable and plausible (92 → 107), but it
  ends at 1|107.07|107.07 against checkpoint 1|107.05|107.05. Canonical sale
  issues show production 1–2 cents away from the replay as early as 2026-08-17
  (recorded 106.68 vs replay 106.66).
- Emulating pre-2026-08-02 float rounding (adjustInventory moved to decimal.js in
  3635b8c36) does not close the gap. The drift sits in August. The likely cause
  is ordering: legacy offloads are placed at their user-entered `offloaded_at`
  date (midnight), and `container_offloads` has no entry timestamp. Candidate
  evidence for the real entry time is the "Freight for offloaded container"
  journal vouchers (from 2026-04-29), but they link to offloads only through
  description text, so they need a proof-grade link before use.
- V34 adds a `REWIND_ERROR_AMPLIFICATION` warning (worst sensitivity per key) to
  measure this conditioning problem across all keys before choosing a blocking
  threshold.

## POS sale-cost mismatches (run #39: 12,811 blocked rows on 317 keys)

The blocker fires when the checkpoint rewind reaches an original POS sale issue
(`pos-sale:V:revN:ITEM`, which journals the locked live rate) and infers a
different pre-sale rate. A forward replay of sampled keys shows two causes.

1. **Unrecorded revaluations (≈35 keys).** Company 10 (Golden Coast), key
   132/6282, sold at a recorded 33.15–33.16 through 2026-08-31 and at 37.07 from
   2026-09-01, with no stock movement in between. Location 131 jumped to the same
   37.07 at the same moment. Across the canonical journal there are 45 such
   jumps (two consecutive original sale issues at a key, no movement between,
   recorded rates more than 0.02 apart). 35 of them fall on 2026-09-01 – 09-04,
   mostly company 10, often moving an item to one identical rate across
   locations 131/132/133.
   - Writers in the code that change average_rate/total_value without a
     movement or an audit row: `updateCostPricesByBarcode` (location
     cost-price import: rate = price, value = qty × price) and direct
     location inventory imports.
   - No surviving evidence of when they ran or what they wrote was found:
     audit_log has nothing, Render request logs do not reach back that far, and
     `sp_migration_cutover_stock_deltas` is empty (the SP Phase 4 migration
     never ran). The cash/bank "revaluation service" is FX only.
   - Sales before such a jump cannot be proven by rewinding from the
     checkpoint, so the blocks are correct. V37 labels these boundaries
     `UNRECORDED_REVALUATION_DETECTED` (warning) so they are not confused
     with model drift.
   - Possible recovery to explore: re-anchor the rewind at the last pre-jump
     original sale (rate pinned, value within ±0.005×qty) and accept a value
     candidate only if it is unique against every earlier recorded live rate.
2. **Cent-level drift (most of the rest).** Mismatches of 0.01–0.05, the same
   pattern as item 702: forward replays stay within a few cents of production,
   but the rewind cannot reach the recorded rate exactly. Causes still open.
   Float rounding (pre-2026-08-02) and legacy offload ordering (fixed in V36)
   were ruled out or corrected for the cases examined.
   - The same writers above mean that undetected revaluations before canonical
     journaling (2026-08-15) can exist anywhere. The V32 evidenced-rate range
     and V35 amplification guards are the safety net for those.
