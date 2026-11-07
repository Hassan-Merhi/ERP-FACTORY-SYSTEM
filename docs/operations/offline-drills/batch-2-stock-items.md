# Drill: batch 2, stock item create and delete

Passes when every item created offline exists once in the cloud under a cloud
id, every later record that names it lands on that cloud item, and each
planted conflict is held or rejected as written below. Follow the
[common procedure](README.md#common-procedure-every-drill) around these steps.

- **Batch number:** `2`
- **Streams to apply:** `stock`
- **Refusal check (step 2):** laptop B, Inventory → Stock items → **New item**
  → save. Expect HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION`.
- **Time:** about 3 hours including handover.

## Before the outage

Pick from the restored data and write into the drill record:
- `LOC-A` and `LOC-B`: two active locations of the drill company;
- `ITEM-OLD-1`: an item with no stock and no movements (for 2.4);
- `ITEM-OLD-2`: an item with no stock and no movements (for 2.5);
- `ITEM-OLD-3`: an item with no stock and no movements (for 2.6).

## Scenarios (factory offline)

| # | Who | Do on the factory server | Plant in the cloud | Expect on the factory server |
| --- | --- | --- | --- | --- |
| 2.1 | B | Create 5 items `DRL-201` … `DRL-205` (any group, unit PCS) | — | Each saves; ids shown are 1,000,000,000 or higher |
| 2.1b | A | Quick adjust +10 of `DRL-201` and `DRL-202` at `LOC-A`; transfer 4 of `DRL-201` from `LOC-A` to `LOC-B` | — | Saves; stock shows 6 at `LOC-A`, 4 at `LOC-B` |
| 2.2 | B | Create item code `DRL-CODE`, name "Drill code clash" | Create a different item with code `DRL-CODE` | Saves |
| 2.3 | B | Create item `DRL-NAME`, name "Drill Bale Grade X" | Create item `DRL-NAME-C`, same name "Drill Bale Grade X" | Saves |
| 2.4 | A | Delete `ITEM-OLD-1` | — | Deleted |
| 2.5 | A | Delete `ITEM-OLD-2` | Receive 1 unit of `ITEM-OLD-2` at `LOC-A` (any stock-in) | Deleted |
| 2.6 | A | Delete `ITEM-OLD-3` | Delete `ITEM-OLD-3` | Deleted |
| 2.7 | A | Open an item and try **Merge** and **Change code** | — | Both refused: online only |
| 2.8 | viewer | Sign in as `drill_viewer` on laptop B and try **New item** | — | Refused at once; nothing saved |
| *Cable* | B | Create `DRL-206` and pull laptop B's cable while it saves; plug back, save again | — | Exactly one `DRL-206` on the factory server |

## Conflict decisions (cloud console)

| # | Held as | Approve button | Decision |
| --- | --- | --- | --- |
| 2.2 | `PHASE9_STOCK_ITEM_CODE_TAKEN` | Must be absent | Reject: "Drill 2.2 code clash, re-enter online" |
| 2.3 | `PHASE9_STOCK_ITEM_NAME_EXISTS` | Present | Approve: "Drill 2.3 same name, different item" |
| 2.5 | `PHASE9_STOCK_ITEM_IN_USE` | Must be absent | Reject: "Drill 2.5 item has cloud stock" |

No other record may be held. 2.6 must apply without a hold (already deleted).

## Expected in the cloud after apply

- [ ] `DRL-201` … `DRL-206` exist once each, with cloud ids below 1,000,000,000.
- [ ] `DRL-201` has 6 at `LOC-A` and 4 at `LOC-B`; `DRL-202` has 10 at `LOC-A`.
- [ ] Only the cloud's own `DRL-CODE` exists; the factory's was rejected.
- [ ] Both "Drill Bale Grade X" items exist (`DRL-NAME` and `DRL-NAME-C`).
- [ ] `ITEM-OLD-1` and `ITEM-OLD-3` are deleted; `ITEM-OLD-2` still exists with 1 unit.
- [ ] The relay's second run sent nothing new; preflight `handover` exited 0.

## Reconciliation

Run `drill-reconcile.mjs --batch 2`. Expected:
- failures: 0;
- differences to explain, and only these:
  - the factory's `DRL-CODE` (create rejected, 2.2) if it had stock;
  - `ITEM-OLD-2` at `LOC-A`: factory 0 (deleted), cloud 1 (planted receipt, 2.5).
