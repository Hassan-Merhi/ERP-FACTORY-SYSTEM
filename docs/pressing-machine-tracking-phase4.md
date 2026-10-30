# Pressing Machine Tracking — Phase 4: Physical Confirmation Engine

Branch: `feature/pressing-machine-tracking`

## Complete Phase 4 source implementation

The continuous camera from Phase 3 now POSTs to `/api/factory/pressing-machines/confirm`, which is registered after the existing company and Factory page/tab authorization boundaries. The endpoint saves **physical pressing completed**, *not inventory finalization*. It never updates `factory_bales.status`, touches stock movements or posts vouchers. The existing stock finalization workflow stays independent.

### Request

```json
{
  "barcode": "REF300208",
  "assignmentId": 4,
  "machineId": 2,
  "requestId": "c72872fc-3403-48dc-b915-bca0b82d0d68",
  "deviceCapturedAt": "2026-10-27T09:26:14.000Z"
}
```

The operator's company/user are **never read from the request body**. The API uses authenticated `getActiveCompanyPermissionContext` and Factory tab access, validates `req.body` with strict Zod, and verifies active machine, current assignment, user, and source bale in a transaction.

### Successful response (201 created; 200 exact idempotent replay)

```json
{
  "id": 1245,
  "status": "PRESSING_COMPLETED",
  "referenceNumber": "REF300208",
  "weightKg": "45.000",
  "machineName": "Press 01",
  "confirmedAt": "2026-10-27T07:26:14.123Z",
  "productionDate": "2026-10-27",
  "timezoneName": "UTC",
  "replayed": false,
  "inventoryFinalized": false
}
```

The response additionally includes company-scoped bale, machine, assignment, user, session, article, name, capture time and request ID. The UI displays **server** time to seconds and KG; device timestamp is retained for evidence. `production_date` is computed from the server-confirmation instant and the configured factory timezone in `factory_settings.extra_settings` (`pressingTimezone`, then `companyTimezone`, then `timezone`). With none configured, UTC is the explicit safe fallback. Phase 7 sets supervisor-configurable shifts/timezone, and Phase 5 handles offline capture-date reconciliation.

### Duplicate and error semantics

- **409 PRESSING_ALREADY_CONFIRMED:** Existing active confirmation for same company+bale, across all machines, users, shifts, and dates. Returns original time/machine/employee in `previous`.
- **409 PRESSING_REQUEST_ID_REUSED:** Client reused an idempotency key for a different barcode, user, machine or assignment.
- **409 PRESSING_CONFIRMATION_VOIDED:** Exact old idempotency request points to a voided record and must not return an active success response. Supervisor correction/reconfirmation is a later phase.
- **409 PRESSING_ASSIGNMENT_CHANGED / PRESSING_SESSION_STALE:** User's assignment changed, or their prior session no longer matches.
- **403 PRESSING_WRITE_DENIED / PRESSING_USER_INACTIVE:** Read-only users or inactive accounts cannot confirm pressing.
- **404 PRESSING_BALE_NOT_FOUND:** Unknown, company-mismatched, or deleted bale.
- **422 PRESSING_NON_BALE_ITEM / PRESSING_MACHINE_INACTIVE:** Non-bale product or inactive machine; inventory lifecycle status never blocks a valid pressing scan.

### Concurrency and authoritative evidence

The same company+user transaction advisory lock as Phase 2 serializes assignment changes and new sessions. Machine and assignment rows are locked; the non-deleted bale is locked irrespective of stock status. An accepted session is automatically opened for the employee (initially with `shift_id=NULL`; Phase 7 adds configured shift assignment). The partial unique DB index `(company_id, bale_id) WHERE voided_at IS NULL` prevents two active confirmations across machines for the entire lifetime of the bale, even if racing requests reach the same database from different servers. The unique `(company_id, request_id)` gives retry idempotency.

A created completion and its audit record commit within one transaction; they roll back together if anything fails. Unknown network errors are **not** shown as success. Phase 5 will implement durable local retry preserving the same `requestId`.

### Phase 4 limitations

- **No daily history UI or saved filters** yet. Phase 6 handles that; accepted scans already persist in the database.
- **No offline queue** yet. Phase 5 will persist and retry unchanged requests on poor internet; a failed network response is ambiguous, so the UI does not claim completion.
- **No automatic iPhone barcode decoding on browsers without native BarcodeDetector** until a bundled decoder is installed and tested on-device.
- **No shift scheduling** yet. Phase 7 will link supervisor-defined shifts.
- **No supervisor void endpoint** yet. Phase 8 will implement corrections and audit-safe reconfirmations.

## Eligibility update (2026-10-27)

The pressing confirmation endpoint accepts any active, company-owned factory bale for its first physical pressing confirmation, including IN_STOCK, RESERVED_FOR_ORDER, FINALIZED, SOLD and DISPATCHED. Deleted/soft-deleted references, non-bale products and previously confirmed bales remain ineligible. No inventory or accounting mutation is performed. The status matrix has been added to the database integration test, and the static contract now checks this policy.

## Prior executed verification (before eligibility update; isolated PostgreSQL 16.15)

`tests/pressing-machine-tracking.database.test.ts`: first scan returns 201 with reference, KG, machine, operator, assignment, session, shift, server time, factory-local date and request ID; the same request ID replays as 200 `replayed: true` with one stored row; the same ID with another barcode is `PRESSING_REQUEST_ID_REUSED`; the same bale from a second operator on another machine is `PRESSING_ALREADY_CONFIRMED` with the original machine/operator; finalized (`IN_STOCK`), soft-deleted, unknown and other-company references are refused; View Only is `PRESSING_WRITE_DENIED`; another operator cannot use this operator's assignment; four racing confirmations of one bale from two operators on two machines yield exactly one 201 and three 409s; six concurrent retries of one request ID yield one row. After every write the source bale is still `PENDING_PRESSING` with its original weight and the voucher count is unchanged.

## Verification required before merge or deploy

Run `npx vitest run tests/pressing-machine-phase4-contract.test.ts` and `npm run test:frontend -- client/src/pages/factory/pressing-scanner/pressingConfirmClient.test.ts` on a checked-out branch, plus existing Phases 1–3 tests, TypeScript checking and migration validation. Against isolated Postgres, race two workers on different presses confirming the same bale and ensure exactly one 201; repeat the same request ID and expect original 200 with no new rows; alter identity with same ID and expect 409; attempt inactive, cross-company, non-bale and deleted bales; verify finalized and other non-deleted statuses are accepted once; assert no stock, voucher or mix changes.
