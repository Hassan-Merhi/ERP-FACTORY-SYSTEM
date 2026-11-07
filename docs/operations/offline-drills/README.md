# Offline plan staging drills

Owner-approved plan of 2026-11-06. Each offline plan batch stays refused on the
factory server until its drill below passes on staging and the owner signs the
drill record. These drills prove the batches on staging only; production stays
off until the release gates in the
[offline roadmap](../../superpowers/plans/2026-10-30-offline-integrated-roadmap.md)
are passed.

| Drill | Script | Run on |
| --- | --- | --- |
| Batch 2: stock item create and delete | [batch-2-stock-items.md](batch-2-stock-items.md) | Day 1 |
| Batch 3: transfers and Excel imports | [batch-3-transfers-imports.md](batch-3-transfers-imports.md) | Day 2 |
| Batch 4: payment edits and deletes, file renames and moves | [batch-4-payments-files.md](batch-4-payments-files.md) | Day 3 |
| Every session: read-only laptops, old queues, operator buttons | [session-checks.md](session-checks.md) | Each day |
| Drill record (one per batch) | [drill-record-template.md](drill-record-template.md) | Each day |

## Owner decisions (2026-11-06)

1. **Where:** a spare PC on the factory LAN runs the staging factory server; a
   separate cloud instance on its own database is the staging cloud.
2. **Data:** a recent production copy with customer contact details masked.
3. **People:** the owner (approver), one factory Admin, one factory Manager,
   and a DBA for the fence, epoch and apply steps.
4. **Pace:** batches 2, 3 and 4 on separate days, one per session; staging is
   restored from the snapshot between them.
5. **Pass bar:** every scenario must pass. One failure means the batch is not
   approved; the cause is fixed and the whole drill runs again.

## Roles

| Role | Does |
| --- | --- |
| Owner | Watches, plants nothing, signs the drill record |
| Admin (laptop A) | Offline writes that need Admin, conflict decisions on the cloud console |
| Manager (laptop B) | Day-to-day offline writes |
| DBA | Fence and epochs, relays, apply, receipts, preflight, reconciliation |
| Cloud planter | Usually the DBA: makes the planted changes in the staging cloud |

## Staging setup (once)

1. **Staging cloud:** deploy the app at the drill's commit on its own
   database. Restore the masked production copy. The database name or host
   must contain `staging` (the reconciliation script refuses anything else).
   **Staging-only client build:** the offline screens (read-only unlock,
   banner, old-queue window, LAN badge) only appear when
   `OFFLINE_MODE_ENABLED` in `client/src/lib/featureFlags.ts` is `true`. Build
   the staging cloud and staging factory server images from a local copy with
   that one line set to `true`. Never commit or push that change; production
   keeps it `false`.
2. **Staging factory server:** on the spare PC, follow
   [factory-lan-edge.md](../factory-lan-edge.md) §1–4 with its own
   `deploy/lan/.env`: a new `EDGE_SITE_ID`, `EDGE_WRITE_MODE=read-only`,
   `EDGE_APPROVED_PLAN_BATCHES=` (empty). Restore the same masked copy into its
   database so both sides start identical.
3. **Offline schema:** the DBA installs it on both staging databases
   ([runbook §3](../factory-offline-operations-runbook.md#3-one-time-installation-dba-maintenance-window)),
   then the Phase 7 fence and the restricted role script.
4. **Accounts** in the drill company (create them in the staging cloud before
   the restore copy is taken to the factory server, so both sides have them):
   - `drill_admin` (Admin), `drill_manager` (Manager without the adjust-stock
     permission), `drill_viewer` (View Only), `drill_leaver` (Manager, disabled
     during the session checks).
5. **Laptops:** laptop A signed in as `drill_admin`, laptop B as
   `drill_manager`, both on the staging factory server.
6. **Snapshot:** take a database snapshot of both sides now. Every drill starts
   from it.
7. **Evidence folder:** `drill-evidence/<date>-batch-<n>/` on the DBA's
   machine for command output, screenshots and the reconciliation report.

Production `deploy/lan/.env` is not opened at any point during the drills.

## Common procedure (every drill)

The steps reference the runbook's outage and handover procedures; run the
commands on the staging machines only. `compose` below means
`docker compose --env-file deploy/lan/.env -f deploy/lan/compose.yaml` on the
staging factory server.

1. **Restore** both sides from the snapshot. Note the time in the drill record.
2. **Check the batch is refused.** With `EDGE_APPROVED_PLAN_BATCHES` empty, do
   the first scenario's first action on laptop B. It must fail with HTTP 423
   `EDGE_SYNC_UNSUPPORTED_OPERATION`. Screenshot it.
3. **Switch the batch on for staging:** set
   `EDGE_APPROVED_PLAN_BATCHES=<n>` in the staging `deploy/lan/.env`, then
   `compose up -d app`. A typo stops the server (`EDGE_PLAN_BATCHES_INVALID`).
4. **Outage** ([runbook §4.1](../factory-offline-operations-runbook.md#41-internet-outage-cloud--lan)):
   unplug the staging factory server's internet cable. The DBA fences the
   staging cloud and opens LAN epoch N+1, sets `EDGE_WRITE_MODE=lan-primary`
   with the epoch and baseline, and restarts the app. `GET /api/edge/status`
   shows `lan-primary`.
5. **Offline work:** run the batch's scenarios in order. Write the factory-side
   number (item code, transfer number, voucher number, file name) of every
   record into the drill record as you go.
6. **Planted changes:** at each scenario marked *Plant*, the DBA lifts the
   cloud fence, the planter makes the change in the staging cloud, and the DBA
   fences it again. Note the time.
7. **Network pull:** at the scenario marked *Cable*, pull laptop B's network
   cable while it saves, plug it back, and save again.
8. **Power cut:** after the scenarios, switch the staging factory server off at
   the wall, wait 30 seconds, switch it on. Check
   `node scripts/edge/factory-handover-preflight.mjs status` (inside the app
   container) shows the same captured counts as before the cut.
9. **Hand over** ([runbook §4.3](../factory-offline-operations-runbook.md#43-internet-back-lan--cloud-handover)):
   freeze the LAN (`EDGE_WRITE_MODE=read-only`, restart), plug the internet back
   in, open the cloud epoch N+2 with the cloud still fenced for users, then run
   `node scripts/edge/relay-event-outbox.mjs` **twice** and save both outputs.
   The second run must send nothing new.
10. **Apply:** on the cloud, `node --import tsx server/edge/phase9OperatorApply.ts apply <stream>`
    for each stream the batch uses. It stops at each conflict.
11. **Decide conflicts** on the cloud operator console (Offline panel, **Held
    offline records**) as `drill_admin`, following the batch script: approve
    or reject, with the password and a reason of at least 10 characters.
    Re-run `apply <stream>` after each decision until it finishes. Screenshot
    each held record before deciding.
12. **Receipts:** enable the Phase 9 receipts, run the relay and
    `node scripts/edge/fetch-applied-receipts.mjs`, then
    `node scripts/edge/factory-handover-preflight.mjs handover`. It must exit 0.
13. **Reconcile:**

    ```bash
    DRILL_LAN_DATABASE_URL=postgres://...staging-factory... \
    DRILL_CLOUD_DATABASE_URL=postgres://...staging-cloud... \
      node scripts/edge/drill-reconcile.mjs --batch <n> --company <id> --site <EDGE_SITE_ID>
    ```

    Exit 0 = clear. Exit 1 = a failure: the drill fails. Exit 2 = differences
    to explain: each listed stock or ledger difference must match a planted
    change or a rejected record in the drill record; anything else fails the
    drill. Save the report.
14. **Reset:** set `EDGE_APPROVED_PLAN_BATCHES=` again unless the owner signs
    the record on the spot, open the cloud for users, and restore both sides
    from the snapshot before the next drill.

## After a drill

The owner signs the drill record. Claude (or the developer on duty) adds a
dated line to the runbook section
[Plan batches stay off until their staging drill is approved](../factory-offline-operations-runbook.md#plan-batches-stay-off-until-their-staging-drill-is-approved)
naming the batch and the record. The approved batch is listed in
`EDGE_APPROVED_PLAN_BATCHES` on staging; production gets the same line only at
rollout.

**Rollback** at any time: remove the batch number and restart the factory
server. Its routes are refused again at once; records already captured still
relay and apply.
