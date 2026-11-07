# Drill: batch 3, transfers and Excel imports

Passes when every transfer ends in the cloud in the state the factory left it,
each import moves stock exactly once, and a transfer changed on both sides is
never silently overwritten. Follow the
[common procedure](README.md#common-procedure-every-drill) around these steps.

- **Batch number:** `3` (batch 2 does not need to be on: these scenarios use
  items that exist in both copies)
- **Streams to apply:** `stock`
- **Refusal check (step 2):** laptop A, open transfer `T-EDIT` and save a
  change. Expect HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION`.
- **Time:** about 4 hours including handover.

## Before the outage (in the staging cloud, before the snapshot)

Create and write into the drill record:
- `T-NEW-SRC`: nothing; 3.1 creates its transfer offline;
- `T-EDIT`, `T-CLASH`, `T-FIN`: three **pending** transfers `LOC-A` → `LOC-B`
  of 5 units of `ITEM-S1` each;
- `T-REV`, `T-REV-CLASH`: two **finalized** transfers `LOC-A` → `LOC-B` of 5
  units of `ITEM-S1` each;
- `ITEM-S1`, `ITEM-S2`, `ITEM-S3`: items with at least 100 units at `LOC-A`;
- `transfer-50.xlsx`: a transfer import sheet of 50 rows moving 1 unit each of
  items with stock at `LOC-A` to `LOC-B`;
- `inventory-3.xlsx`: an inventory import for `LOC-A` setting `ITEM-S1`,
  `ITEM-S2`, `ITEM-S3` each to 10 units below the snapshot figure, except
  `ITEM-S3`, which it sets to 0.

## Scenarios (factory offline)

| # | Who | Do on the factory server | Plant in the cloud | Expect on the factory server |
| --- | --- | --- | --- | --- |
| 3.1 | A | Create a transfer `LOC-A` → `LOC-B` of 3 `ITEM-S2`; edit it to 4; finalize it | — | Finalized with 4 |
| 3.2 | A | Edit `T-EDIT` to 6 units | Edit `T-EDIT` to 7 units | Saves |
| 3.2b | A | Edit `T-CLASH` to 8 units | Edit `T-CLASH` to 9 units | Saves |
| 3.3 | A | Finalize `T-FIN` | Edit `T-FIN` to 2 units | Finalized with 5 |
| 3.4 | A | Request a revision of `T-REV` to 4 units, then approve that revision | — | Revision approved |
| 3.5 | A | Request a revision of `T-REV-CLASH` to 3 units | Revise `T-REV-CLASH` to 2 units and approve it | Revision pending |
| 3.6 *Cable* | A | Import `transfer-50.xlsx`; pull laptop A's cable during the upload, plug back, import again | — | One transfer of 50 lines (the retry is recognised) |
| 3.7 | A | Import `inventory-3.xlsx` at `LOC-A` | Receive 5 extra `ITEM-S2` at `LOC-A` | Saves; `ITEM-S3` shows 0 |
| 3.8 | B | Import `inventory-3.xlsx` as `drill_manager` (no adjust-stock permission) | — | Refused; nothing saved |

## Conflict decisions (cloud console)

| # | Held as | Approve button | Decision |
| --- | --- | --- | --- |
| 3.2 | `PHASE9_STOCK_TRANSFER_CHANGED` | Present | Approve: "Drill 3.2 factory edit wins" |
| 3.2b | `PHASE9_STOCK_TRANSFER_CHANGED` | Present | Reject: "Drill 3.2b keep the cloud edit" |
| 3.3 | `PHASE9_STOCK_TRANSFER_CHANGED` | Present | Approve: "Drill 3.3 factory finalize wins" |
| 3.5 | `PHASE9_STOCK_TRANSFER_CHANGED` | Must be absent | Reject: "Drill 3.5 stale revision" |

3.7 is held only if the cloud figure would go below zero
(`PHASE9_STOCK_WOULD_GO_NEGATIVE`, approvable). With the planted receipt it
should apply without a hold. No other record may be held.

## Expected in the cloud after apply

- [ ] 3.1's transfer exists once, finalized, 4 `ITEM-S2`.
- [ ] `T-EDIT` has 6 units; `T-CLASH` has 9 (cloud edit kept); `T-FIN` is
  finalized. Write down its quantity: the factory finalized the 5 units it saw,
  the cloud had edited it to 2.
- [ ] `T-REV` shows the approved revision (4); `T-REV-CLASH` shows the cloud's
  revision (2) and no factory revision.
- [ ] Exactly one transfer from `transfer-50.xlsx`, with 50 lines.
- [ ] `LOC-A`: `ITEM-S1` 10 lower than the snapshot (minus transfers),
  `ITEM-S2` 10 lower plus the planted 5, `ITEM-S3` at the cloud figure minus
  the factory's change (quantity changes, never overwritten balances).
- [ ] The relay's second run sent nothing new; preflight `handover` exited 0.

## Reconciliation

Run `drill-reconcile.mjs --batch 3`. Expected:
- failures: 0 (this includes "no transfer number twice");
- differences to explain, and only these:
  - `ITEM-S2` at `LOC-A`: cloud 5 higher (planted receipt, 3.7);
  - `ITEM-S1` at `LOC-A` and `LOC-B`: from `T-FIN` (finalized against the
    cloud's edit, 3.3) and `T-REV-CLASH` (cloud revision kept, 3.5), by the
    quantities written down above.
