# Pressing Machines — Phase 8: Corrections, Audit & Final Integration

**Branch:** `feature/pressing-machine-tracking`. Do not merge/rebase/deploy automatically.

## Supervisor correction workflow

Location: **Factory → Stock Entry → Pressing Machines → Permanent Pressing History → Detailed**.

The supervisor sees confirmed and already-voided records, with a **Review void** action only for active confirmations. Clicking it reveals the original bale reference, machine, KG and server timestamp. The supervisor must:

1. Enter a reason of 10–1000 characters explaining the mistake.
2. Re-enter the **exact bale reference** in the separate confirmation field.
3. Explicitly click **Void pressing confirmation**.

An ordinary operator does not see these controls. The backend independently requires an authenticated Manager, Admin, Owner or Developer role (not POS View Only) in the current company. The existing Factory stock-entry/pressing tab permission middleware protects the route, too.

Endpoint: `POST /api/factory/pressing-machines/confirmations/:id/void` with strict body:
`{ "reason": "Incorrect scan attributed to this bale" }`.

## Atomic, append-only audit

The backend finds the confirmation by current company+ID, acquires machine → bale → original-confirmation locks, and refuses already-voided records (409). In **one database transaction**, it:

- inserts `factory_pressing_corrections` with `action=VOID`, mandatory reason and supervisor actor;
- sets ONLY `voided_at` and `voided_by` on the original confirmation;
- inserts the central immutable ERP audit-log action `void` with reason, timestamp and correction ID.

The existing database protection trigger rejects deletion, edits to original machine/operator/KG/time/barcode, or voiding without an already-inserted corresponding correction event. The correction table's UPDATE/DELETE trigger makes corrections append-only. A failed step rolls back the entire transaction.

This operation changes **physical pressing analytics only**, subtracting the voided confirmation from *active* bale/KG totals. It DOES NOT reverse inventory, stock finalization, ERP vouchers, raw material costing, stock movements, or a physical offload.

## Safe re-confirmation

After supervisor void, the partial unique index `(company_id,bale_id) WHERE voided_at IS NULL` permits a **new, separately validated** pressing confirmation for the same bale, only if it remains eligible `PENDING_PRESSING`.

The regular scanner runs every original Phase 4 rule again: authenticated operator, active matching machine assignment, machine not down, pending bale, one active confirmation across all machines, server timestamp, UUID request id and transaction audit.

When a newly accepted confirmation follows a voided one, the backend also inserts an immutable `RECONFIRM` correction event with:

- original voided confirmation ID;
- **replacement confirmation ID**;
- reference to the previous supervisor void;
- original voiding supervisor identity.

The scanner cannot resubmit the old UUID to bypass the void. Reusing an original voided request ID returns `PRESSING_CONFIRMATION_VOIDED`, not a green success. A new valid request ID creates a new record; racing duplicate machines remain protected by the database's partial unique active-bale index.

## Correction history

The supervisor-only `GET /api/factory/pressing-machines/corrections` endpoint provides the latest 100 entries in the UI (maximum 200 in API). It supports exact reference lookup and original confirmation ID filtering, always scoped to the authenticated company, with parameterized SQL.

The UI shows action, original and replacement IDs, supervisor, precise event timestamp and reason. Active production totals in the daily report use only nonvoided rows, while **Voided** or **All** status filters retain the old evidence for review.

The Phase 5 local queue retains the immutable originally received server receipt. Its panel now explains that a supervisor may later void it and that the **Permanent Pressing History** is the source for *current* active totals.

## Final eight-phase integration boundaries

- **P1:** underlying machine/assignment/session/confirmation/shift/downtime/correction/view schema, tenant-specific indexes, immutable triggers.
- **P2:** manager machines and one active machine assignment per operator.
- **P3:** continuous phone camera scanner with sound/vibration and no frame-level duplicate flood.
- **P4:** server-accepted pressing records with lifetime duplicate prevention. Independent of inventory finalization.
- **P5:** durable IndexedDB saved-request retry with immutable idempotency key and company/operator isolation.
- **P6:** PostgreSQL-backed permanent history, date/machine/operator/article filters, saved views and all-selected-pages Excel export.
- **P7:** supervisor IANA-zone shifts, overnight session rollover, manually recorded machine downtime and *observed* scan-window analytics.
- **P8:** supervisor corrections with mandatory reason, append-only void/replacement history and per-action audit.

**No new migration is required in Phase 8**: the Phase 1 DDL already includes confirmation-void and correction append-only triggers. Existing phase migrations and indexing are not altered by the correction code.

## Required verification before merge or Render

The following is a TEST PLAN, **not a claim these tests were executed**:

```sh
npm run check
npx vitest run tests/pressing-machine-phase8-contract.test.ts
npx vitest run tests/pressing-machine-phase7-contract.test.ts server/services/factory/pressingShiftTime.test.ts
npx vitest run tests/pressing-machine-phase6-contract.test.ts tests/pressing-machine-phase5-contract.test.ts tests/pressing-machine-phase4-contract.test.ts
npx vitest run tests/pressing-machine-phase3-source.test.ts tests/pressing-machine-phase2-access.test.ts
npx vitest run tests/startup-schema-integrity.test.ts
npm run verify:migrations
```

**Isolated PostgreSQL transaction/permissions matrix**:
1. Confirm bale REF once; try confirming the same bale simultaneously from two machines and two workers; exactly one active row must survive.
2. Void it with a supervisor and valid reason; verify one immutable VOID correction, one central audit-log event, unchanged original reference/operator/machine/KG/timestamps, and new `voided_at/by` only.
3. Try to void again: 409, no additional correction.
4. Try to void as a worker, POS view-only user, another company, or unapproved pressing tab: 403/404, no writes.
5. Try to UPDATE or DELETE correction and confirmation history directly: database trigger must reject.
6. Retry the old original scan UUID after void: should **not** return active success.
7. Rescan with a new UUID on an eligible pending bale; new confirmation and `RECONFIRM` linkage both commit together. Trigger must still protect original and replacement.
8. Try a new scan when the bale has been finalized, machine deactivated, assignment changed or downtime opened: rejected, no new confirmation.
9. Void while a scan is in flight. Verify machine/bale locking prevents double-active records and no stale financial changes.
10. Confirm that active report summary/analytics drop by exactly one bale and the correct KG after void, that the void remains available under Voided/All, and that a permitted replacement is counted **once**.
11. Run offline disconnected scan, reconnect, simulate lost response, switch users/companies; verify no duplicate active confirmation or cross-tenant queued replay.
12. Test Android/iOS camera availability, invalid references, permission revocation, company switching, daylight-saving and overnight shifts, downtime controls, history filters, and XLSX exports.

**Known readiness limitations:** Native `BarcodeDetector` is not available on every iPhone/browser; a cross-browser bundled decoder and physical device tests are still needed for universal continuous-camera compatibility. Browser-stored offline scans can be lost if IndexedDB data is cleared. Excel export is limited to 30,000 rows/groups per workbook. All eight phases are **source-implemented, not production-validated**.

No merge or Render deployment has been performed by this phase.
