# Pressing Machines — Phase 5: Durable Offline Capture & Safe Retry

**Branch:** `feature/pressing-machine-tracking`  
**Scope:** One committed barcode confirmation request per scanner read, durable local queue, retry safety and mobile status.  
**Main and Render:** No merge or deployment as part of this phase.

## Safety decisions

The Phase 4 POST `/api/factory/pressing-machines/confirm` remains the only authority for a pressing completion. A captured barcode is never counted as complete locally merely because it was detected, queued, transmitted, or timed out. Only a successful server receipt matching all original scan identifiers changes local state to **Confirmed**.

Every capture is saved to a dedicated IndexedDB database *before* any HTTP attempt. Saved identity/payload fields:
- company ID and user ID from the authenticated `GET /api/factory/pressing-machines/me` response;
- immutable `requestId` UUID;
- bale barcode/reference, machine ID, assignment ID;
- ISO device-capture timestamp, creation timestamp, attempts, last error and next retry time.

The same `requestId` and entire original payload are reused on **every** retry, including uncertain network errors after the server may have committed. The backend has an existing unique `(company_id, request_id)` index and returns the same receipt for an identical request; a different submission with an already-confirmed bale hits its lifetime company+bale uniqueness constraint.

## Status transitions and worker feedback

| Local state | Meaning | Worker feedback |
| --- | --- | --- |
| Pending | Browser has durably saved scan; may be offline or waiting backoff | Amber; NOT counted |
| Sending | HTTP validation in progress, original request ID retained | Amber; NOT counted |
| Confirmed | Matching, verified server completion receipt has been saved locally | Green; server time including seconds |
| Rejected | Server definitively rejected duplicate, invalid bale, revoked assignment or role | Red; retain reason for review |

The scanner shows a local capture time and, after acceptance, separate authoritative server confirmation time, exact seconds, machine, KG and record ID. It remains open between barcodes. A same-device unread pending barcode is not enqueued twice; cross-device duplicates are rejected by the PostgreSQL constraint.

A queue status card under the scanner shows per-operator pending, sending, confirmed and rejected counts, recent records, server record IDs, connectivity, errors, and **Retry pending**. Rejected scans remain visible; this phase does not allow workers to void, alter, or delete audit records.

## Retry lifecycle

- Offline: `navigator.onLine === false` means **store only**, no POST.
- Online: store, revalidate the active authenticated company and user, then POST the immutable queued request.
- Network loss, timeout, 408, 429 and 5xx: preserve pending request with exponential backoff from 1.5s to 60s.
- Server 401 / expired session: leave pending and pause until the original user signs back into the original company.
- Terminal 4xx including duplicate `PRESSING_ALREADY_CONFIRMED`, invalid bale, machine reassignment and permission revocation: retain Rejected, do not endlessly retry.
- Unrecognized or mismatched receipt: preserve pending, rather than wrongly show a success.
- Browser reload during Sending: recover the outstanding row from IndexedDB and send it again with its **original** request ID.
- While the page is active, recheck every 12 seconds, when the internet reconnects, when the page becomes visible, or when the worker presses Retry pending.
- Retry up to eight due rows per processing pass. Stop on a continuing transient failure rather than hammer the service.
- A single ordered delivery chain per page serializes every HTTP request, including scans captured while an earlier request is still in flight: each saved scan waits its turn, posts its own immutable request ID and reports its **real** server outcome to the scanner (it is not left amber until the next 12-second pass). A scan that a background pass already settled keeps that terminal state; one in backoff is not re-posted early. The backend unique indexes remain the final cross-tab/device concurrency boundary.
- Before syncing any saved row, `GET /api/factory/pressing-machines/me` must return the original `companyId` and `userId`. Other companies' and other operators' rows are not loaded into the page or replayed.

## Storage and user-visible limitations

IndexedDB is durable across normal reloads, **not a cloud backup**. Clearing browser/app storage, using private mode, device data loss, or unavailable/quota-exceeded IndexedDB can destroy unsynced scans. The UI warns workers. If a new barcode cannot be durably stored, the client refuses to POST it and clearly reports failure; it never pretends the scan was saved. The queue caps unresolved scans at 500 per operator to avoid unchecked storage growth.

Once server-confirmed, pressing history is in PostgreSQL permanently, separate from local device history. Calendar filters, full company reporting and saved views arrive in Phase 6. Shift settings in Phase 7 and authorized supervisor correction in Phase 8 are unchanged.

The generic ERP `localStorage` offline queue explicitly excludes all `/api/factory/pressing-machines` requests. Pressing must only use the dedicated IndexedDB queue so no duplicate replay mechanism is active.

This implementation does **not** finalize inventory, change bale inventory status, consume mix material, alter costing or create vouchers.

## Executed verification (2026-10-27)

- `client/src/pages/factory/pressing-scanner/usePressingOfflineSync.test.tsx` (jsdom, in-memory IndexedDB stand-in): ordered delivery with real per-scan outcomes, offline store-only behaviour and same-barcode de-duplication, retry with the original request ID, and refusal to replay rows under a different company or operator.
- `tests/pressing-machine-tracking.database.test.ts`: six concurrent submissions of one request ID produce one row and five `replayed` receipts; a voided request ID returns `PRESSING_CONFIRMATION_VOIDED`.
- Real IndexedDB behaviour across browser reloads, private mode and quota exhaustion was not exercised on a device in this environment.

## Verification still required before merge/deploy

Run on a checked-out branch:

```sh
npm run check
npx vitest run tests/pressing-machine-phase5-contract.test.ts tests/pressing-machine-phase4-contract.test.ts
npm run test:frontend -- client/src/pages/factory/pressing-scanner/pressingConfirmClient.test.ts client/src/pages/factory/pressing-scanner/pressingOfflineQueue.test.ts
```

Additionally verify in a real browser with IndexedDB, and against isolated PostgreSQL:
1. Disconnect internet; scan multiple distinct barcodes. Confirm they are Pending and survive a full page reload.
2. Restore internet; confirm each receives one saved server completion and transitions green. Compare client and database timestamps.
3. Simulate a committed server transaction followed by lost response; resend the **same** UUID and confirm 200 replay, no second row.
4. Switch factory company or operator while items remain pending; ensure no replay or display under the wrong company/user.
5. Send the same bale from two machines/devices. Confirm only one successful row and one duplicate rejection.
6. Expire authentication, disable machine or revoke the assignment before retry; ensure no unauthorized pressing success.
7. Deny IndexedDB and simulate quota failure; verify fail-closed, with no HTTP request.
8. Keep the camera open continuously during weak internet, then navigate away. Verify no camera leak and no inventory/voucher changes.

**No live PostgreSQL or device testing is asserted by source implementation alone.**
