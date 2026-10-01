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
