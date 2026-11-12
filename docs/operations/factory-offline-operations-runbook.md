# Factory offline operations runbook (Phases 9–11)

**Status: development on `feat/offline-mode-integration`, NOT production-certified.**
All flags stay off, the LAN server stays `read-only`, and nothing here may be
run against production until the release gates at the end are signed off.
Earlier setup steps live in [factory-lan-edge.md](factory-lan-edge.md) (LAN
server install, TLS, Phase 7 fence, Phase 8 voucher replay) and the release
gate in [factory-lan-phase6-certification.md](factory-lan-phase6-certification.md).

## 1. How authority moves

Exactly one database accepts business writes at a time. The Phase 7 PostgreSQL
fence (`phase7_writer.state` + per-table triggers) enforces that at the
database, not only in the application.

| State | Cloud database | Factory LAN server | Laptops use |
|---|---|---|---|
| Normal | `cloud-primary` epoch N | `read-only` (prepared reads only) | cloud |
| Outage | fenced (no writes) | `lan-primary` epoch N+1 | LAN server |
| Handover back | `cloud-primary` epoch N+2, users still fenced at HTTP | frozen `read-only` | nobody writes |
| Normal again | `cloud-primary` epoch N+2, users unfenced | `read-only` | cloud |

During the outage the LAN commits every supported business write together with
immutable evidence in the **same PostgreSQL transaction**. Cloud application is
deliberately a supervised step during the handover window — never a background
loop racing live factory writes — because cloud staging and apply also require
an open cloud epoch.

## 2. What works on the factory server during an outage

| Workflow | LAN-primary | Evidence stream | Cloud apply |
|---|---|---|---|
| Journal voucher (USD, ledger-only, balanced, no attachment) | yes | `vouchers` (Phase 4/8) | `server/edge/phase8OperatorApply.ts` |
| Factory cash-box Payment / Receipt (USD; one Cash account against expense or income accounts) | yes | `vouchers` (Phase 4/8) | `server/edge/phase8OperatorApply.ts` — account types re-checked in the cloud; banks, payables, receivables, stock and employees refused |
| Pressing scan confirmation (physical bale press) | yes, existing machine assignments only | `pressing` (Phase 9) | `server/edge/phase9OperatorApply.ts apply pressing` |
| Stock movement: inventory quick adjust (add / subtract at a location) | yes, existing items and locations | `stock` (Phase 9) | `server/edge/phase9OperatorApply.ts apply stock` — replayed as a delta; below zero is held for Admin/Developer approve/reject |
| New stock transfer (`POST /api/stock-transfers`, create-from-scratch form; the existing-voucher form is refused) | yes, existing items and locations | `stock` (Phase 9) | `server/edge/phase9OperatorApply.ts apply stock` — replayed through the same transfer code on the LAN request id, with a cloud voucher number; a source the cloud cannot cover is held for Admin/Developer approve/reject |
| Stock-item master edits: bulk price update, bulk category, bulk rename, bulk unit fix, the update-by-code imports (names, categories, opening balances, barcodes), location prices and single-item edits | yes, existing items only; whitelisted fields (name, unit, selling price, category, group, active, opening balances, location prices, new barcodes) | `stock` (Phase 9) | `server/edge/phase9OperatorApply.ts apply stock` — each field applied only while the cloud value still equals what the LAN saw; a field the cloud changed meanwhile is held for Admin/Developer approve (LAN value wins) or reject; a re-coded or missing item, a missing category/group/location or a barcode another item holds is reject-only |
| New stock item (`POST /api/stock-items`) and stock item delete (`DELETE /api/stock-items/:id`) | yes; the new item gets an id from the reserved LAN range (1,000,000,000 and up) and keeps the code the user typed; delete only for an item with no stock movements | `stock` (Phase 9) | `server/edge/phase9OperatorApply.ts apply stock` — the create makes the cloud item and records the LAN-id → cloud-id mapping (`factory_edge_stock_item_map`); every later record naming the LAN id is translated, and waits (no conflict) until the create has applied; a code the cloud already uses is reject-only, an item with the same name is held for Admin/Developer approve/reject; a delete of an item the cloud still holds stock of, or has movements for, is reject-only |
| Changes to an existing stock transfer: edit (`PUT /api/stock-transfers/:id`), finalize/approve (`POST /api/vouchers/:id/finalize` for transfer vouchers, `POST /api/stock-transfers/:id/approve`), revisions (`POST /api/stock-transfers/:id/revisions`) and revision approve/reject | yes; other voucher types cannot be finalized offline (HTTP 423) | `stock` (Phase 9) | `server/edge/phase9OperatorApply.ts apply stock` — each change carries the transfer as the factory saw it; a transfer created offline is found through its create's receipt; an edit or finalize of a transfer the cloud changed meanwhile is held for Admin/Developer approve (factory change wins) or reject; a stale revision, a revision no longer pending, or a transfer whose offline create was rejected is reject-only |
| Excel stock-transfer import, single and multi-source (`/api/stock-transfer-import/*`: parse and validate only read; import writes) | yes; each import is created through the same code as a hand-typed transfer | `stock` (Phase 9), as an ordinary `stock.transfer.v1` | replayed like any offline transfer, on its LAN request id; a cloud shortfall is held for Admin/Developer approve/reject |
| Excel inventory import for a location (`POST /api/locations/:id/import-inventory`) | yes, existing items only; needs the stock-adjustment permission; a row below zero is refused | `stock` (Phase 9), each row an ordinary `stock.quick-adjust.v1` | each row's quantity change is added to the cloud's own figure (never an overwritten balance); below zero is held for Admin/Developer approve/reject. Offline, an unknown code is reported (not created) and rows are valued at the location's average cost |
| Payment / Receipt edit (`PATCH /api/vouchers/:id/payment-receipt`) and delete (`DELETE /api/vouchers/:id`, Admin) | yes, once batch 4's drill is approved; intercompany transfer legs stay online-only (409) | `payments` (Phase 9), after the payment itself | each record carries a SHA-256 of the voucher (header and every entry) as the factory saw it. A voucher created offline is found through its create's receipt. The change applies through the same code only while the cloud voucher still has that digest. A changed voucher is held for Admin/Developer approve (factory change wins) or reject. A reconciled voucher, an intercompany leg, a closed period or any other posting refusal is reject-only |
| File rename / move (`PATCH /api/files/:id`) | yes, once batch 4's drill is approved; file deletes stay online-only | `attachments` (Phase 9), after the upload | applied only while the cloud file still has the name and folder the factory saw. A file renamed or moved in the cloud meanwhile is held (approve = factory change wins). A missing target folder is reject-only |
| POS sale — cash, bank or credit; USD or another currency at the cashier's entered rate (non-supplier-partner company) | yes, numbered `LAN-<site>-000123` | `pos` (Phase 9) | `server/edge/phase9OperatorApply.ts apply pos` — replayed through the sale service on its `clientSaleId`; keeps the offline price; below-zero stock or a changed till account is held for Admin/Developer approve/reject |
| Supplier receiving: container offload against its existing purchase orders, and offload edits, with duties, charges, cost corrections and agent lines | yes | `receiving` (Phase 9) | `server/edge/phase9OperatorApply.ts apply receiving` — same offload lifecycle on the receipt's transaction; cloud prices apply; changed order quantities are held for Admin/Developer approve/reject |
| File upload (Files page), up to 10 MB | yes | `attachments` (Phase 9) + signed file upload | `server/edge/phase9OperatorApply.ts apply attachments` — the record syncs first; the relay then uploads the bytes to `/api/edge/sync/files/stage`, accepted only if their SHA-256 matches a staged record; the file is created in the cloud once its bytes arrive; a missing folder is held for approve/reject |
| Supplier, customer, employee and bank Payment / Receipt vouchers (Payments page) | yes, at the rate the user posted | `payments` (Phase 9) | `server/edge/phase9OperatorApply.ts apply payments` — same posting code on the receipt's transaction; a posting refusal (closed period, missing party/account) is a reject-only conflict |
| POS return / sale correction (sale edit, `PUT`/`PATCH /api/vouchers/:id/sales`) | yes | `pos` (same stream as the sale) | replayed through the sale-edit core; the sale is found by its client sale id or (pre-outage) voucher id; below-zero stock held for approve/reject |
| POS sale cancellation (`DELETE /api/vouchers/:id`, sales vouchers only, Admin) | yes | `pos` (same stream as the sale) | replayed through the same delete code; the operator tool refreshes the intercompany POS mirror for the date afterwards; a missing or already-cancelled sale is reject-only |
| Login, logout, company switch | yes (session only) | none | n/a |
| All reads covered by prepared offline reads | yes | n/a | n/a |
| Everything else (1,140 write routes) | **refused** with HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION` | none | n/a |

`node scripts/edge/audit-phase9-write-coverage.mjs` prints the exact current
inventory and fails if any route becomes writable on the LAN without a reviewed
capture policy.

### Laptops that reach neither the cloud nor the factory server (decision 10)

Such a laptop is a **read-only viewer**. It never takes a write.

- **Ticket.** While the user is signed in online and has unlocked the
  encrypted offline cache (Offline panel, passphrase), the browser seals a
  cold-start ticket with that cache's key. The ticket expires 24 hours after
  that online check.
- **No connection after a restart.** The app shows a passphrase screen
  instead of "Reconnecting". The same passphrase opens the cached data for
  viewing until the ticket expires, under the banner "Not connected to the
  factory server: view only".
- **Writes.** Every write is refused in the browser with HTTP 423
  `OFFLINE_COLD_START_READ_ONLY`, before it can be sent or queued. Buttons stay
  visible; whatever they try to save is refused. Signing in again works as
  soon as a connection returns.
- **Data window.** An encrypted cache now stays readable for 24 hours after it
  was prepared. An unencrypted cache keeps 8 hours and never opens on a cold
  start.
- **Wipes.** Signing out wipes that account's ticket on the laptop. When the
  server reports at the next connection that the account was disabled, all
  its tickets are wiped. When the account was removed from a company, that
  company's ticket and cached data are wiped.
- **Proof.** The expiry is bound into the ticket's encryption, so editing it
  on disk makes the ticket fail to open
  (`tests/ui/offline-cold-start-read-only.test.ts`).

### Standalone laptops: browser offline mode (Phases 13–16)

A laptop's browser can keep working when the internet drops, **without the
factory server**, and send what it saved straight to the cloud when the
connection is back. This reverses decision 10 for the entries listed below:
they are saved; everything else on a disconnected laptop is still refused.

**Switched off.** It needs all three of: the client flag
`OFFLINE_MODE_ENABLED` (still `false`), the cloud setting
`OFFLINE_BROWSER_SYNC_ENABLED=1` (default off; the routes answer 404) and the
offline evidence schema on the cloud database (§3, `offlineSchemaInstall.ts
cloud`). Production has none of them.

**What can be saved offline** (client/src/lib/offline/offlineCoverage.ts and
server/offline/browserSync/browserOperationKinds.ts hold the same list):

| Entry | Live route it replaces | Cloud replay |
| --- | --- | --- |
| Payment / Receipt | `POST /api/vouchers/payment-receipt` | payment posting code, at the entered rate |
| Stock adjustment | `POST /api/inventory/quick-adjust` | quick-adjust code, as a change to the cloud's quantity |
| Stock transfer | `POST /api/stock-transfers` | transfer code, keyed by the operation id |
| New stock item | `POST /api/stock-items` | item create; later entries naming it are translated |
| POS sale | `POST /api/pos/sales` | sale service; must name the account it was paid into |

Journal vouchers keep their existing durable path.

**How a laptop saves.** Only when the app already knows it is offline (browser
offline, failed health checks, or the sealed read-only ticket) is a supported
write saved, never after a request was cut off mid-send. It is stored in
IndexedDB, separate per company and user, sealed with AES-GCM under a
non-extractable key made for that user on that laptop; only a label (type and
amount) is readable. The screen says "Saved offline". A double click within two
minutes is saved once. Records can be edited until they may have reached the
cloud. Every other write is refused with the reason it needs a connection.

**How it syncs** (client/src/lib/offline/browserSync.ts →
`POST /api/offline/browser-sync/operations`): when the connection returns (or
on **Sync now**), the browser re-checks the session and sends the signed-in
user's records for the active company, one at a time, in the order saved per
stream. The cloud takes the actor from the session, builds the Phase 9
evidence envelope from the entered values, runs the same handler as the LAN
replay (authorize → apply → verify) and writes the receipt in the same
transaction, under the laptop's device id. A record counts as synced only when
the receipt names that operation. A lost acknowledgement returns the stored
receipt; a changed record under the same id is refused. Failures retry with
backoff; an expired session pauses; a conflict or refusal stops that stream
until the user decides.

**Conflicts.** The cloud never overwrites: it rolls back and reports the code.
In the offline panel (banner drawer, and Factory settings) the user can try
again, discard (recorded in the cloud as rejected) or, as an Admin or
Developer and only for a code the entry declares overridable, apply it anyway.
The cloud checks the role and the code again.

**Controls.** Connection state, counters (saved, waiting, synced, needing a
decision), Sync now, Pause/Resume delivery, storage used, removing synced
records, and a recovery copy (readable JSON of unsynced entries, for re-entry
by hand if the laptop must be replaced).

**Still needs a connection, and why:**

| Category | Reason |
| --- | --- |
| Editing or deleting existing cloud records | Needs the cloud's current version so nothing is overwritten; the browser has no version token for cloud records yet. |
| Pressing scans | Need the machine's current assignment, the bale and the shift day from the cloud at scan time. |
| Files and attachments | Bytes are not stored on the laptop. |
| Supplier receiving (container offload) | The replay exists, but the browser would need the order lines and prices cached; not wired yet. |
| Payroll, rentals, month-end accounting | Can wait; high conflict risk. |
| Users, permissions, settings | Must change in one place. |
| WhatsApp, chat, other outside services | Unreachable offline. |
| Password or manager-approval actions | Checked by the server at that moment. |
| Everything else | Not reviewed for offline replay. |

**Not verified yet.** The code is covered by automated tests (cloud endpoint on
the full schema; queue, delivery, capture and panel in the browser test
suite). It has not been run on real laptops or in production, and the staging
drills do not cover it yet.

### Entries left in the old browser queues

Some browsers still hold entries saved offline before the current design
(localStorage `erp_offline_queue`, IndexedDB `syncQueue`). They were never
sent, and they never will be automatically.

- **Move.** At the next sign-in on that browser they move into an encrypted
  store, under a non-extractable key held by that browser. The originals are
  removed only after the encrypted copies are stored.
- **Who sees them.** Admin, Owner and Developer users of the company get a
  list showing date, type and amount. The old entries recorded no user, so
  they are not shown to other roles. Entries with no known company appear for
  every company.
- **Choices.** **Re-enter** shows the entry's full details; the user types it
  again through the normal form, which goes through the server's checks, then
  marks it re-entered. **Discard** drops it. The form is not pre-filled.
- **Log.** Each choice is recorded in the audit log with the user's name
  (`POST /api/offline/legacy-queue/decisions`, table
  `offline_legacy_queue_entries`) before it takes effect. If it cannot be
  recorded, nothing changes.
- **Retention.** Entries nobody handles are deleted after 30 days.

### Plan batches stay off until their staging drill is approved

The rows added by the owner-approved plan of 2026-11-05 are:
- batch 2: new stock items and item deletes;
- batch 3: transfer edits, finalizes and revisions, and the Excel transfer
  and inventory imports;
- batch 4: Payment / Receipt edits and deletes, and file renames and moves.

They are refused on the factory server (HTTP 423) until the owner has run
that batch's staging drill and approved it. The drill scripts, the drill
record and the reconciliation command are in
[offline-drills/](offline-drills/README.md). Record the approval in
`deploy/lan/.env` and restart the server:

```
EDGE_APPROVED_PLAN_BATCHES=2,3
```

On the factory server, Payment / Receipt creates, edits and deletes are served
by the payment routes that record them for the cloud, not by the central
posting routes. They use the same posting code the cloud replays, and the
same `clientRequestId` keeps a retried create from posting twice.

Leave it empty to keep every plan batch off. An unknown value stops the
server at startup (`EDGE_PLAN_BATCHES_INVALID`). The coverage audit lists
each gated route with its `planBatch`. Workflows approved before the plan are
not gated, and neither is the operator Pause/Resume button, which writes no
business data.

### Why the remaining workflows are online-only

A workflow is approved only when it has: an atomic LAN capture in its own
transaction, a typed and hashed event contract, a cloud apply handler that
reproduces the effect exactly once under the writer fence, deterministic
conflict detection, and a PostgreSQL reconciliation test. Enabling a route
without all of that would let the factory record transactions that cannot be
reconciled safely, which is worse than refusing them.

- **Merging or re-coding stock items (owner decision 2026-11-05: stays
  online-only); inventory cost-price imports; legacy
  transfer line edits (`PATCH /api/stock-transfer-items/:id`), the voucher
  editor's transfer save (`PATCH /api/vouchers/:id/transfer`) and reopen;
  bale lifecycle, production finalisation:** a merge or re-code rewrites the
  identity every other offline record uses to find its item; the cost-price
  import and the remaining transfer paths go through separate code that has
  no replay handler yet. Quick adjustments, inventory imports, new and imported transfers,
  transfer edits, finalizes and revisions, new items, item deletes and master
  edits of existing items are offline (above).
- **Deletes and edits of other voucher types:** each posts money and stock
  together through the central posting engine with multi-currency, tax and
  numbering rules. Only POS sales and Payment / Receipt vouchers are edited
  or deleted offline (above). Intercompany transfer legs stay online-only.
- **Other documents and imports:** offline file upload, rename and move cover
  the Files page; file deletes, imports and document exports stay
  online-only.
- **Pressing voids/corrections and machine assignment changes:** supervisor
  actions on the cloud's view of the same records; they stay cloud-only so a
  void can never race a LAN scan of the same bale.

Adding a workflow means registering a new event kind in
`server/edge/phase9EventProtocol.mjs`, a capture call inside the route's
transaction, an apply handler, and drill coverage — the framework is shared.

### Owner-approved offline policies (2026-11-01)

The owner approved these rules for the remaining workflows. Each workflow is
switched on only after it is implemented, passes its outage drill on the
owner's staging cloud and spare factory server, and gets owner sign-off.

| Workflow | Offline rule | When the cloud disagrees after the outage |
|---|---|---|
| Stock movements | Recorded as quantity changes (deltas), never overwrites. | A movement that would take cloud stock below zero is **held** for an Admin/Developer to approve or reject. Nothing is dropped silently. |
| POS sales | Separate invoice series per factory server (for example `LAN1-000123`). Prices, tax and exchange rates are the last values synced before the outage; the receipt says "offline price". Cash sales only; no credit sales above the owner's limit. | Price or rate drift is recorded, not re-priced; the sale keeps its offline price. |
| Payments | Factory cash box only, USD or the last synced rate. No bank transfers and no supplier payments offline. | Held for review if the cash account changed or was closed in the cloud. |
| Supplier receiving | Only against purchase orders that already exist; quantities only, no price changes. | The price is applied by the cloud when the receipt syncs; a receipt against a changed or closed order is held. |
| Attachments | Up to 10 MB per file, kept on the factory server; the record syncs first, then the file, and each upload is checked for completeness (hash). | A file whose hash does not match is rejected and re-sent. |

Owner decision 2026-11-02 extended these: offline POS takes credit, bank and
non-USD sales at the rate the cashier enters, plus returns and cancellations;
supplier, customer and bank payments; receiving edits with duties and charges;
and stock transfers and stock-item bulk edits/imports (the rules in section 2).

Conflict reviewers: users with the **Admin** or **Developer** role. Held
items are listed in the operator status panel and decided with the audited
operator tools.

## 3. One-time installation (DBA, maintenance window)

1. Follow [factory-lan-edge.md](factory-lan-edge.md) §1–4 for the LAN server.
2. Install the evidence schema with a privileged migration login (never the
   runtime role), once per database, in a reviewed maintenance window:

   ```bash
   FACTORY_OFFLINE_SCHEMA_INSTALL_ACK=DBA_REVIEWED_MAINTENANCE_WINDOW \
     node --import tsx server/edge/offlineSchemaInstall.ts cloud   # on the cloud DB
   FACTORY_OFFLINE_SCHEMA_INSTALL_ACK=DBA_REVIEWED_MAINTENANCE_WINDOW \
     node --import tsx server/edge/offlineSchemaInstall.ts lan     # on the LAN DB
   ```

   Each target installs in one transaction. Then (re)install the Phase 7 fence
   (`deploy/lan/phase7-install-writer-fence.sql`) so the new tables are fenced.
3. Grant the restricted runtime role only what it needs. In addition to the
   business DML the application already uses, the event apply needs:
   - `INSERT` on `factory_edge_staged_events`, `factory_edge_applied_events`,
     `factory_edge_event_conflicts`; `INSERT, UPDATE` on
     `factory_edge_event_stage_cursor` and `factory_edge_event_apply_cursor`;
   - `UPDATE` on `factory_pressing_machines`, `factory_pressing_assignments`,
     `factory_bales` (PostgreSQL requires it for the `SELECT … FOR UPDATE` row
     locks the live route also takes);
   - **no** privilege on `factory_edge_event_conflict_decisions` beyond
     `SELECT` — conflict decisions are a DBA action.
   - Re-running `deploy/lan/phase7-prepare-restricted-role.sql` after the
     evidence schema is installed keeps this boundary: its broad business-table
     grant is followed by read-only access to `factory_edge_apply_approvals`,
     `factory_edge_event_conflict_decisions` and
     `factory_edge_sync_control_log` (approvals, conflict decisions and relay
     pause/resume are DBA operator actions).
4. The LAN write guard admits pressing scans only when the capture tables and
   their immutability triggers exist; otherwise scans get HTTP 503
   `EDGE_PHASE9_PRESSING_CAPTURE_NOT_INSTALLED` instead of failing mid-scan.

## 4. Procedures

### 4.1 Internet outage: cloud → LAN

1. Confirm the outage is real (WAN down, not a TLS or cloud HTTP error).
2. DBA fences the cloud database (`phase7_writer.state.mode = 'fenced'`) or, if
   the cloud is unreachable, records that the cloud is down and that no cloud
   writer can be reached.
3. DBA opens LAN epoch N+1 on the LAN database and sets
   `FACTORY_EDGE_WRITE_MODE=lan-primary` with the matching
   `FACTORY_EDGE_WRITER_EPOCH` and `FACTORY_EDGE_BASELINE_SHA256`.
4. Restart the LAN app; check `GET /api/edge/status` shows `lan-primary`.
5. Laptops switch to the LAN origin (the LAN badge shows which server they use).

### 4.2 During the outage

- Pressing workers keep scanning with their existing assignment. Unsupported
  actions return a clear refusal; nothing is queued that cannot be replayed.
- `node scripts/edge/factory-handover-preflight.mjs status` shows captured,
  staged, applied and pending counts per stream at any time.
- Restarting or powering off the LAN server is data-safe: evidence is committed
  with the business row. A refreshed browser either sees the committed scan
  (and gets the same receipt on retry with the same request ID) or the rolled
  back transaction left nothing behind.

### 4.3 Internet back: LAN → cloud handover

1. **Freeze the LAN:** set `FACTORY_EDGE_WRITE_MODE=read-only` (remove the epoch
   and ACK) and restart. No new LAN business writes can commit.
2. **Open the cloud epoch:** DBA sets cloud `phase7_writer.state` to
   `cloud-primary` epoch N+2. Keep `FACTORY_CLOUD_WRITE_MODE=fenced` so users
   cannot write through HTTP yet, and enable `FACTORY_SYNC_RECEIVE_ENABLED=1`.
3. **Stage:** on the LAN run `node scripts/edge/send-voucher-outbox.mjs` and
   `node scripts/edge/relay-event-outbox.mjs`. Both are idempotent; rerun after
   any network error.
4. **Apply:** on the cloud, with the Phase 8/9 operator variables set,
   - `node --import tsx server/edge/phase8OperatorApply.ts <sequence>` per voucher;
   - `node --import tsx server/edge/phase9OperatorApply.ts apply pressing`.
   The event apply stops at the first conflict (see §4.4).
5. **Receipts:** enable `FACTORY_PHASE8_RECEIPTS_ENABLED=1` and
   `FACTORY_PHASE9_RECEIPTS_ENABLED=1`, then rerun the LAN relays and
   `scripts/edge/fetch-applied-receipts.mjs`. Only receipts that match the local
   immutable evidence are recorded.
6. **Preflight:** `node scripts/edge/factory-handover-preflight.mjs handover`
   must exit 0 (every LAN operation has a verified applied or operator-rejected
   cloud receipt).
7. **Reconcile** (see §5), then set `FACTORY_CLOUD_WRITE_MODE=primary`, disable
   the apply flags, and move laptops back to the cloud.

### 4.4 Conflicts

A conflict means the cloud disagrees with a LAN event — for example the cloud
already holds a different scan of the same bale, the machine/assignment/bale
no longer matches, or the worker lost access before reconciliation. The apply
transaction rolls back, the conflict is written to
`factory_edge_event_conflicts`, and the stream stays blocked at that sequence.

- **On screen (cloud operator console):** start a cloud instance with the same
  settings as the apply (`FACTORY_SYNC_RECEIVE_ENABLED=1`,
  `FACTORY_PHASE9_APPLY_ENABLED=1`, the apply acknowledgement, site, company,
  baseline and cloud epoch, and the database fence settings). An Admin or
  Developer of the approved company sees **Held offline records** in the
  Offline panel: each held record with its reason, **Approve** (only where the
  rules allow it) and **Reject**. Both need the user's password again and a
  reason of at least 10 characters. The decision is written by the DBA-owned
  function `factory_edge_operator_decide_conflict`, which re-checks the user.
  On an ordinary cloud instance the panel does not appear
  (`EDGE_OPERATOR_CONSOLE_DISABLED`). The command-line steps below do the same.
- Inspect: `node --import tsx server/edge/phase9OperatorApply.ts status` and the
  conflict row's `code`/`detail`.
- Decide: `node --import tsx server/edge/phase9OperatorApply.ts reject
  <stream> <sequence> <reviewer-username> "<reason, at least 10 characters>"`.
  The reviewer must be an active **Admin or Developer** user of the company;
  any other username is refused (`PHASE9_REVIEWER_NOT_AUTHORIZED`).
- Re-run `apply <stream>`: the sequence receives an immutable
  `rejected-conflict` receipt and the stream continues. The cloud record is
  never overwritten; if the LAN fact must still be recorded, enter it again in
  the cloud as a new, normal transaction.
- **Approve instead (stock, POS, receiving and attachments):** a stock movement held as
  `PHASE9_STOCK_WOULD_GO_NEGATIVE` (for example a physical count proves the
  LAN issue happened and a cloud receipt is late) can be applied anyway with
  `... phase9OperatorApply.ts approve stock <sequence> <reviewer-username>
  "<reason>"`, then `apply stock`. Only conflict codes a stream declares
  overridable can be approved (`PHASE9_CONFLICT_NOT_OVERRIDABLE` otherwise);
  a missing item or location, revoked access or a diverged replay can only be
  rejected. Every other check still runs on the approved apply. For POS, a
  sale held as `PHASE9_POS_STOCK_WOULD_GO_NEGATIVE` or
  `PHASE9_POS_CASH_ACCOUNT_CHANGED` can be approved with `approve pos ...`.
  A receipt held as `PHASE9_RECEIVING_ORDER_CHANGED` can be approved with
  `approve receiving ...`; the cloud then receives its current order
  quantities. A file held as `PHASE9_ATTACHMENT_FOLDER_MISSING` can be
  approved with `approve attachments ...`; it is stored at the top level.
- A record dated in an accounting period the cloud has closed is held as
  `PHASE9_PERIOD_CLOSED` (payments, stock, transfers, receiving) or as the
  stream's own refusal code (payment and transfer edits); it can only be
  rejected. Re-enter the fact in the cloud in an open period.
- An attachment record waits (no conflict, `PHASE9_ATTACHMENT_FILE_NOT_STAGED`)
  until the relay has uploaded its bytes; re-run the relay, then `apply
  attachments`. The relay checks each file against its recorded SHA-256 before
  sending and logs the cloud's acknowledgement, so a file is sent once.
- POS replays run through the normal sale service in its own transaction;
  exactly-once comes from the sale's `clientSaleId` (the LAN operation id), so
  an apply interrupted after the sale committed is reported as
  `already-present` on the next run, never posted twice.

### 4.5 Pause and resume delivery

On the factory server, an Admin or Owner presses **Pause delivery** (or
**Resume delivery**) in the Offline panel and gives a reason and their
password. The DBA-owned function `factory_edge_operator_sync_control` checks the
user and appends a `pause` or `resume` row, with the user's name and reason, to
`factory_edge_sync_control_log` (`recordPhase10SyncControl` in
`server/edge/phase10SyncControl.mjs` remains the DBA path). While paused, both
relays transmit nothing; evidence is untouched. Use it during cloud incidents,
restores or audits.

### 4.6 Backup, restore and disaster recovery

- Take encrypted LAN backups with `deploy/lan/backup-encrypted.sh` (database and
  uploads, `age`-encrypted). Schedule them at least hourly during an outage.
- Restore only into a **new** database
  (`deploy/lan/rehearse-encrypted-bootstrap.sh`); never in place.
- After restoring a LAN backup, rerun the relays: staging and receipts are
  idempotent, so already-delivered events are not re-sent or duplicated, and
  any events newer than the cloud cursor are staged normally. The drill test
  proves this with a restored database copy.
- If the LAN server is lost entirely, everything that reached `staged` is safe
  in the cloud inbox; anything only captured locally since the last backup is
  lost with the hardware. Keep the backup interval short for that reason.

## 5. Reconciliation checks after handover

Run on the LAN after receipts are fetched:

```sql
-- every captured scan has exactly one verified cloud outcome
SELECT count(*) AS captured, count(r.sequence) AS with_receipt
  FROM factory_edge_pressing_outbox o
  LEFT JOIN factory_edge_event_applied_receipts r
    ON r.site_id = o.site_id AND r.stream = 'pressing'
   AND r.sequence = o.sequence AND r.operation_id = o.operation_id;
```

Run on the cloud: each `cloud-applied` pressing receipt maps to exactly one
non-voided `factory_pressing_confirmations` row with the same `request_id`, and
no request ID or active bale appears twice. Voucher reconciliation follows
[factory-lan-edge.md](factory-lan-edge.md) (Phase 8).

## 6. Monitoring

| Signal | Command / endpoint | Alert when |
|---|---|---|
| LAN mode and data proof | `GET /api/edge/status` | mode/writeMode not as planned |
| Per-operation state | `GET /api/edge/status?operationId=<uuid>` (authenticated) | `conflict` |
| LAN backlog | `factory-handover-preflight.mjs status`, or `GET /api/edge/operator/status` (LAN, Admin/Owner; also shown in the Offline panel as "Factory server sync status") | `pendingTotal` grows during WAN-up time |
| Cloud streams | `phase9OperatorApply.ts status` | `openConflicts > 0` |
| Relay paused | `relayPaused: true` in the preflight report | paused longer than planned |

## 7. Verification evidence

Automated on disposable PostgreSQL (`tests/offline-phase9-pressing-sync-drill.test.ts`,
`tests/offline-phase8-postgres.test.mjs`, `tests/offline-phase9-pressing-postgres.test.ts`)
and in unit/contract suites run by the offline Phase 8/9 workflows:

| Scenario | Evidence |
|---|---|
| Normal connection / cloud authority | Phase 7 fence + restricted-role proof in apply |
| Sudden disconnection | relay WAN-down step: nothing recorded, rerun succeeds |
| Several laptops at once | concurrent capture from three clients: gapless sequences |
| Many simultaneous transactions | same; advisory-lock ordered capture |
| LAN server restart | restored database copy resumes without re-staging |
| Browser refresh mid-transaction | rolled-back capture leaves no evidence and no gap |
| Cloud outage | staging refused ⇒ nothing marked staged; rerun later |
| Reconnection | relay stages all pending events in order |
| Interrupted sync | interrupted apply rolls back business rows, receipt and cursor |
| Duplicate sync attempts | repeated relays stage 0; repeated apply replays the stored receipt |
| Lost acknowledgements | lost stage ACK and lost apply ACK, both without duplicates |
| Conflicting stock-type update | cloud already holds the bale scan ⇒ conflict, blocked, decided |
| Conflicting financial transaction | Phase 8: divergent replay and missing predecessor refused |
| Expired/revoked access | worker removed before apply ⇒ `PHASE9_ACTOR_ACCESS_REVOKED`; Phase 8 role revocation |
| Company switching / isolation | tenant FK on capture, relabelled evidence refused, approved-company check |
| Failed DB transaction | capture rollback test; apply rollback test |
| Backup and restore | restored LAN copy relays idempotently |
| Server shutdown/reactivation | same as restart; evidence committed with the business row |
| Authority handover | stale epoch refused (`PHASE9_CLOUD_WRITER_FENCE_UNVERIFIED`) |
| Full reconciliation | drill's final LAN/cloud reconciliation and handover preflight |

These are database-level drills. They do not replace the hardware drills in
the Phase 6 certification matrix (real WAN cut, power loss, two physical
laptops), which remain release gates.

## 8. Release gates that remain open

- Phase 7: trusted cloud→LAN baseline restore, live restricted runtime role and
  migration/DDL split on cloud and LAN, managed-Postgres event-trigger review.
- Real factory hardware drills (Phase 6 matrix) on the exact release commit.
- Independent security and database review; owner/operator sign-off.
- Coverage beyond vouchers and pressing (see §2) if those workflows must work
  during an outage.

Until then keep `OFFLINE_MODE_ENABLED=false`, `FACTORY_EDGE_WRITE_MODE=read-only`
and every `FACTORY_PHASE8_*` / `FACTORY_PHASE9_*` flag unset in production.
