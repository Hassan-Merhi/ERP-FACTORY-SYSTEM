# Automatic Priority Printing & Loading — Phase 5 handoff

## Status

**Phase 5 implementation is committed** to the same `feat/automatic-priority-print-loading` feature branch as Phases 1–4. No separate branch or PR was opened.

**No tests, type checks, formatting, static checks, print tests or CI were run.** Claude is responsible for compiling, testing, CI and hardware verification later. This is a code-complete handoff, not a production-readiness certification. Company switch remains OFF by default.

## Print/reprint behavior — non-negotiable

- Every print entry point that prints a **physical factory bale** must consult the authoritative server assignment. If eligible, it is allocated under the existing company Priority Scan lock and the destination snapshot (loading, priority, color) is returned.
- Reprinting an already allocated bale never inserts a second active allocation, cannot move the bale, and **always uses the original saved color even when automatic mode is now OFF or the queue changed**.
- A bale with no eligible priority prints as a normal label and remains unallocated in stock.
- Deletion/reversal removes active allocation but preserves original scan evidence. Deleted/non-company bales cannot be silently reprinted.
- Never infer a priority color in the browser. A customer logo, article design color, or previous bale's color must not substitute for the persisted Priority Scan color.
- A monochrome Zebra printer is **not** used for color-requiring priority labels; the browser print path renders the colored HMD wordmark on A4, A5, and sticker artwork.

## Batch endpoint (new)

`POST /api/factory/customer-orders/loading-list/automatic-print-preflight-batch`

Body:

```json
{
  "items": [
    { "baleId": 501, "referenceNumber": "REF000501" },
    { "referenceNumber": "REF000502" }
  ]
}
```

Response:

```json
{
  "results": [
    {
      "baleId": 501,
      "referenceNumber": "REF000501",
      "priorityAllocation": {
        "baleId": 501,
        "referenceNumber": "REF000501",
        "orderId": 21,
        "priority": 1,
        "color": "#dc2626",
        "source": "stock-entry",
        "existing": true
      }
    },
    { "baleId": 502, "referenceNumber": "REF000502", "priorityAllocation": null }
  ]
}
```

The endpoint accepts 1–200 physical-bale entries, deduplicates repeated IDs, and uses a **single transaction + company Priority Scan lock**. One invalid, deleted, mismatched, or foreign-company reference rejects the entire batch. Its effects commit before the browser renders any printable document. The result is ordered by first occurrence of each unique bale.

`client/src/lib/priorityPrintPreflight.ts` is the common client preflight and snapshot mapper. It refuses an incomplete/mismatched response and blocks printing a stale, previously assigned label with no longer valid assignment. Its `withRecordedPriorityAllocations` helper maps existing `/api/bale-label-prints` audit response allocations by physical bale ID, never by array index or customer color.

## Integrated printing entry points

| Workflow | Backend preparation | Client labels |
| --- | --- | --- |
| New Stock Entry | Stock Entry already allocates transactionally in Phase 4; print endpoint obtains confirmed snapshot | Existing A4/A5/sticker, correct HMD color |
| Stock Entry "Remove from Stock" print | `/api/bale-label-prints` multi-bale preflight | Existing stock/priority label |
| Factory Reprint Labels | **Atomic batch preflight** + existing per-bale reprint audit | Original loading/color; safe Zebra fallback |
| Location Inventory reprint | **Atomic batch preflight** + existing per-bale reprint audit | Original loading/color; safe Zebra fallback |
| Bale History reprint | Existing authenticated `/api/bale-label-prints/reprint` | Original loading/color; safe Zebra fallback |
| Bale Relabeling | **Atomic reference-based batch preflight** | New reference with original bale assignment color |
| Wipers Re-Entry | **Atomic bale-ID batch preflight** | A4/A5/sticker; Print All now honors selected A5 |
| Legacy Pressing Create + Print | `/api/bale-label-prints` confirmed snapshots | Original 76mm label for ordinary bales; colored-HMD priority artwork for prioritized bales |
| Legacy Production Finalize + Print | `/api/bale-label-prints` confirmed snapshots | Original finalization label for ordinary bales; colored-HMD priority artwork for prioritized bales |
| Existing ordinary/standalone label without physical factory bale | No priority routing | Existing original print layout |

`/api/bale-label-prints` prepares all known physical bale IDs together before audit inserts. Reprint endpoint validates current company ownership and that the bale is not deleted. Existing standalone/offline references without a physical bale do not trigger allocation.

## Code changed in this phase

- `server/routes/factory/customer-orders/priorityAutoAllocation.ts`: batch transaction and saved manual/auto snapshot lookup before OFF check.
- `server/routes/factory/customer-orders/priorityScanConfigRoutes.ts`: authenticated, company-scoped batch API.
- `server/routes/baleRoutes.ts`: atomic preparation of existing physical bales and safe reprint validation.
- `client/src/lib/priorityPrintPreflight.ts`: shared fail-closed browser preparation.
- `client/src/pages/factory/FactoryReprintLabels.tsx`: batch preflight and existing audit.
- `client/src/pages/factory/factorylocationinventory/useFactoryLocationReprint.ts`: batch preflight and existing audit.
- `client/src/pages/factory/WipersReEntry.tsx`: batch preflight and A5 Print All fix.
- `client/src/pages/factory/FactoryBaleRelabeling.tsx`: batch preflight on new reference.
- `client/src/pages/PressingBales.tsx`: priority-aware labels, legacy normal output unchanged.
- `client/src/pages/ProductionBales.tsx`: priority-aware finalized labels, legacy normal output unchanged.
- `tests/setup.ts`: factory-company test fixture for this phase.
- `client/src/lib/priorityPrintPreflight.test.ts`: unrun unit regressions.
- `tests/automatic-priority-print-batch-phase5.test.ts`: unrun integration regressions.

## Claude verification checklist

1. Run TypeScript/build, the new Phase 5 tests, the previous phases' regression tests, then full CI only during Claude's verification.
2. Print a mixed batch (Red, normal, Blue) from all supported print surfaces and confirm correct label for **each physical reference**.
3. Reprint a Red bale after changing its configuration to Blue and switching the feature OFF; the bale must remain Red in its original loading.
4. Concurrently request reprints from separate operators: exactly one active order-bale link, one original auto-allocation snapshot, one active Priority Scan history entry.
5. Attempt a batch with one valid unallocated bale and one invalid ref. Neither may be newly allocated.
6. Print repeatedly from Factory Reprint Labels, Bale History, Location Inventory, Wipers, and Relabeling; no duplicate allocations, correct label print audit behavior.
7. Verify Stock Entry press/finalize and printed barcodes on real hardware, especially color printers versus monochrome Zebra, mixed ordinary/priority labels, and design/color selectors.
8. Test mode OFF, no matching proforma, full capacity, deleted bales, cross-company bale IDs, browser popup blocks, label image loading, A4/A5/sticker margins.
9. Confirm any reprint failure after server allocation is clearly reported and can be retried without assigning the bale twice.

Phases 6–8 (deletion/reversal hardening, priority recovery and full rollout/testing) remain pending. Do not enable this feature in production until Claude verifies all phases.
