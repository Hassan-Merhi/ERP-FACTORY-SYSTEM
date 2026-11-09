# Factory Unification — Phase 5 Implementation Record

**Date:** 2026-11-09  
**Working branch:** `factory/unification-8-phases-2026-11-09`  
**Status:** SOURCE IMPLEMENTATION COMPLETE — RUNTIME UNVERIFIED  
**Verification performed:** GitHub source inspection and post-write re-reads. CI, Vitest, TypeScript build, browser/manual camera checks and backend integration tests were **not** run, as requested for CI and unavailable for local runtime.

## Shared primitives adopted
1. `shared/factoryLocalDate.ts`: typed Beirut calendar date for a Date/instant and pure deduplicated past-date computation. Uses the existing `PRESSING_TIME_ZONE` / `Asia/Beirut` and Intl calendar parts, never a fixed UTC offset.
2. `client/src/pages/factory/factoryattendance/attendanceEditPolicy.ts` and `server/routes/factory/attendanceEditPolicy.ts` now invoke the same shared Beirut calendar function. **The server still independently enforces** prior-date Admin password approval, future-date rejection, rate limiting and company-scoped Admin credential verification; no policy relaxation.
3. `FactoryAttendance.tsx` uses `attendanceToday` for both selected date and range-export initial dates rather than mixing Beirut today and the user's device-local today. Date range traversal, payroll/attendance calculations and exports were not modified.
4. `client/src/factory/scanner/cameraUiErrors.ts`: camera permission/device-in-use/error messages as a pure presentation utility. `ContinuousPressingScanner.tsx` now uses this utility and `factoryLocalDateFromInstant`; decoding, streaming camera cleanup, USB/manual handler, wake lock, scan gate and audio feedback remain intact.
5. `client/src/factory/scanner/scannerFeedback.ts`: typed confirmation/duplicate/rejected/queued/syncing display labels with explicit `factoryScanIsConfirmed`. `PressingOfflineQueueStatus.tsx` consumes the existing display labels from this helper without changing receipt or queue semantics.
6. `tests/factory-unification-phase5.test.ts`: authored (not executed) characterization for DST date rollovers, past-date deduplication, camera UI errors, server-confirmed versus pending feedback and existing continuous scan gate behavior.

## Existing canonical scanner foundations (retained)
- `MobileBarcodeScanner.tsx` already routes camera reads through each page-specific onScan handler and provides a common native/ZXing decoder with cleanup and duplicate-frame gate. The Factory loading dispatch scanner and Stock Entry scanner already use it.
- `pressing-scanner/continuousScanGate.ts` already suppresses repeated camera frames without blocking a different barcode. No change to threshold or server duplicate enforcement.
- `pressing-scanner/pressingOfflineQueue.ts` and `usePressingOfflineSync.ts` are pressing-specific, durable, request-idempotent, company/operator-scoped persistence and synchronization layers. **Not merged** into the dispatch scanner's transient in-memory queue, which is a different workflow and must not imply durable offline verification.

## Critical preservation / non-goals
- No change to attendance Admin approval payload, rate limits, API endpoints or attendance/payroll storage.
- No change to pressing scan confirmation, authorization, machine assignment, saved timestamps, production accounting, stock finalization, retry policy, durable IndexedDB queue or idempotency.
- No change to Factory dispatch verification, original loading, physical inventory, invoices, proformas, vouchers or accounting.
- No new SQL, migrations, financial adjustments, backfills, or files renamed.
- No claim that local queued scans are permanently confirmed or counted before server acceptance.

## Follow-on checks before production or fully verified DONE
- Run TypeScript and focused tests locally without CI if a checkout becomes available.
- Verify `Asia/Beirut` DST and midnight using both browser and server, plus prior-day Admin approval under View Only/Create Only/Owner/Admin roles.
- Test camera permission deny/retry, stream/track cleanup on unmount, fold/orientation, flashlight, keyboard wedge, two different sequential scans and duplicate scans.
- Test pressing queue offline/reconnect, session change, same requestId replay, receipt-count parity and wrong-company rejection.
- Test dispatch scanner's own non-durable queue separately; no inferred offline guarantees.
- Verify no side effects on stock, loading, invoices, proformas or accounting.
 
**Merge:** Deferred. All changes remain on the single unification branch.
