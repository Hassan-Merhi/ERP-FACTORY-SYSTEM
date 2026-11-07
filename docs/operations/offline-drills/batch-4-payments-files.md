# Drill: batch 4, payment edits and deletes, file renames and moves

Passes when the cloud ledger matches the factory's to the cent apart from the
planted and rejected records listed below, no voucher is edited or deleted
twice, and a voucher or file changed in the cloud is held instead of
overwritten. Follow the [common procedure](README.md#common-procedure-every-drill)
around these steps.

- **Batch number:** `4`
- **Streams to apply:** `payments`, then `attachments`
- **Refusal check (step 2):** laptop A, open Payment `P-EDIT` and save a
  change. Expect HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION`.
- **Time:** about 4 hours including handover.

## Before the outage (in the staging cloud, before the snapshot)

Create and write into the drill record, all in USD in an open period, using
a factory cash box account against an expense or income account:
- `P-EDIT`, `P-CLASH`, `P-CLASH-2`, `P-REC`, `P-PERIOD`: five Payments of
  100.00;
- `R-EDIT`: one Receipt of 250.00;
- `P-IC`: one leg of an intercompany transfer;
- `P-PERIOD` dated in the last month that is still open (4.5 and 4.12 use
  that month);
- `FOLDER-A`, `FOLDER-B`, `FOLDER-GONE`: three file folders;
- `scan-1.pdf`, `scan-2.pdf`, `scan-3.pdf`: three files in `FOLDER-A`.

## Scenarios (factory offline)

| # | Who | Do on the factory server | Plant in the cloud | Expect on the factory server |
| --- | --- | --- | --- | --- |
| 4.1 | A | Create a Payment of 75.00; edit it to 80.00; delete it | — | Gone; the cash box is back where it started |
| 4.2 | A | Edit `R-EDIT` to 260.00 and move its date one day earlier | — | Saves |
| 4.3 | A | Edit `P-CLASH` to 110.00 | Edit `P-CLASH` to 120.00 | Saves |
| 4.3b | A | Edit `P-CLASH-2` to 110.00 | Edit `P-CLASH-2` to 120.00 | Saves |
| 4.4 | A | Delete `P-REC` | Reconcile `P-REC` against a bank statement line | Deleted |
| 4.5 | A | Edit `P-PERIOD` to 90.00 | Close the period that holds `P-PERIOD` | Saves |
| 4.6 | A | Open `P-IC` and try to edit or delete it | — | Refused (409): intercompany legs stay online |
| 4.7 | B | Delete `P-EDIT` as `drill_manager` (delete is Admin only) | — | Refused; nothing saved |
| 4.8 | A | Rename `scan-1.pdf` to "Signed invoice" and move it to `FOLDER-B` | — | Saves |
| 4.9 *Cable* | B | Upload `scan-new.pdf` to `FOLDER-A`, pulling the cable mid-upload and retrying; then rename it to "Offline scan" | — | One file "Offline scan" |
| 4.10 | A | Rename `scan-2.pdf` to "Factory name" | Rename `scan-2.pdf` to "Cloud name" | Saves |
| 4.11 | A | Move `scan-3.pdf` into `FOLDER-GONE` | Delete `FOLDER-GONE` | Saves |
| 4.12 | A | Create a Payment of 30.00 dated in the same month as `P-PERIOD` | (the period closed in 4.5) | Saves |

## Conflict decisions (cloud console)

| # | Held as | Approve button | Decision |
| --- | --- | --- | --- |
| 4.3 | `PHASE9_PAYMENT_CHANGED` | Present | Approve: "Drill 4.3 factory edit wins" |
| 4.3b | `PHASE9_PAYMENT_CHANGED` | Present | Reject: "Drill 4.3b keep the cloud edit" |
| 4.4 | `PHASE9_PAYMENT_RECONCILED` | Must be absent | Reject: "Drill 4.4 voucher is reconciled" |
| 4.5 | `PHASE9_PAYMENT_EDIT_REFUSED` naming the closed period | Must be absent | Reject: "Drill 4.5 period closed" |
| 4.10 | `PHASE9_ATTACHMENT_FILE_CHANGED` | Present | Approve: "Drill 4.10 factory name wins" |
| 4.11 | `PHASE9_ATTACHMENT_FOLDER_MISSING` | Must be absent | Reject: "Drill 4.11 folder deleted in the cloud" |
| 4.12 | `PHASE9_PERIOD_CLOSED` | Must be absent | Reject: "Drill 4.12 period closed, re-enter in an open period" |

No other record may be held.

## Expected in the cloud after apply

- [ ] 4.1's Payment was created, edited and deleted once each; the cash box
  balance is unchanged by it.
- [ ] `R-EDIT` is 260.00 on the earlier date, posted at the factory's rate.
- [ ] `P-CLASH` is 110.00 (factory won); `P-CLASH-2` is 120.00 (cloud kept).
- [ ] `P-REC` still exists and is still reconciled; `P-PERIOD` is still 100.00.
- [ ] "Signed invoice" is in `FOLDER-B`; "Offline scan" exists once in
  `FOLDER-A`; `scan-2.pdf` is named "Factory name"; `scan-3.pdf` is still in
  `FOLDER-A`.
- [ ] The relay's second run sent nothing new; preflight `handover` exited 0.

## Reconciliation

Run `drill-reconcile.mjs --batch 4`. Expected:
- failures: 0 (this includes "no voucher number twice" and every file whose
  records all applied matching name, folder, size and SHA-256);
- differences to explain, and only these:
  - ledger: the cash box and expense accounts by 10.00 for `P-CLASH-2`
    (cloud 120.00 kept, factory 110.00), by 100.00 for `P-REC` (deleted on the
    factory, kept in the cloud) and by 10.00 for `P-PERIOD` (factory 90.00,
    cloud 100.00), and by 30.00 for 4.12 (created on the factory, rejected in
    the cloud);
  - file: `scan-3.pdf` folder (factory `FOLDER-GONE`, cloud `FOLDER-A`).
