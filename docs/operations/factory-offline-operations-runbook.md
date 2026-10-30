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
| Pressing scan confirmation (physical bale press) | yes, existing machine assignments only | `pressing` (Phase 9) | `server/edge/phase9OperatorApply.ts apply pressing` |
| Login, logout, company switch | yes (session only) | none | n/a |
| All reads covered by prepared offline reads | yes | n/a | n/a |
| Everything else (1,164 write routes) | **refused** with HTTP 423 `EDGE_SYNC_UNSUPPORTED_OPERATION` | none | n/a |

`node scripts/edge/audit-phase9-write-coverage.mjs` prints the exact current
inventory and fails if any route becomes writable on the LAN without a reviewed
capture policy.

### Why the remaining workflows are online-only

A workflow is approved only when it has: an atomic LAN capture in its own
transaction, a typed and hashed event contract, a cloud apply handler that
reproduces the effect exactly once under the writer fence, deterministic
conflict detection, and a PostgreSQL reconciliation test. Enabling a route
without all of that would let the factory record transactions that cannot be
reconciled safely, which is worse than refusing them.

- **Stock movements, adjustments, transfers, bale lifecycle, production
  finalisation:** they mutate quantities and perpetual-inventory journals that
  the cloud may also have changed before the outage was detected. They need a
  per-item conflict model (expected prior quantity/version) before they can be
  replayed; until then a LAN movement could double-count or go negative.
- **POS sales, payments, receipts, purchasing/receiving, supplier and customer
  balances:** each posts money and stock together through the central posting
  engine with multi-currency, tax and numbering rules. Only the narrow USD
  Journal path has a verified replay adapter today.
- **Attachments and documents:** files are not in the database transaction, so
  they need a content-addressed upload transfer and verification step that does
  not exist yet.
- **Pressing voids/corrections and machine assignment changes:** supervisor
  actions on the cloud's view of the same records; they stay cloud-only so a
  void can never race a LAN scan of the same bale.

Adding a workflow means registering a new event kind in
`server/edge/phase9EventProtocol.mjs`, a capture call inside the route's
transaction, an apply handler, and drill coverage — the framework is shared.

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

- Inspect: `node --import tsx server/edge/phase9OperatorApply.ts status` and the
  conflict row's `code`/`detail`.
- Decide (DBA login): `node --import tsx server/edge/phase9OperatorApply.ts reject
  pressing <sequence> "<your name>" "<reason, at least 10 characters>"`.
- Re-run `apply pressing`: the sequence receives an immutable
  `rejected-conflict` receipt and the stream continues. The cloud record is
  never overwritten; if the LAN fact must still be recorded, enter it again in
  the cloud as a new, normal transaction.

### 4.5 Pause and resume delivery

`recordPhase10SyncControl` (`server/edge/phase10SyncControl.mjs`) appends a
`pause` or `resume` row with the operator's name and reason to
`factory_edge_sync_control_log`. While paused, both relays transmit nothing;
evidence is untouched. Use it during cloud incidents, restores or audits.

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
| LAN backlog | `factory-handover-preflight.mjs status` | `pendingTotal` grows during WAN-up time |
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
