# Automatic Priority Printing & Loading

Current behaviour of the company-wide Automatic Priority Printing & Loading
mode. The phase-by-phase implementation handoff notes are kept as records in
`docs/archive/automatic-priority-print-loading-phase1.md` … `phase8.md`; where
they disagree with this page, this page is authoritative.

## Company switch

- Stored per factory company in `factory_settings.extra_settings.automaticPriorityPrintingEnabled`; **OFF** unless explicitly enabled.
- `GET /api/factory/automatic-priority-mode` returns `{ enabled, canEdit }` for the active company (read by any signed-in user of the company).
- `PUT /api/factory/automatic-priority-mode` accepts exactly `{ "enabled": boolean }`. It is owned by the Factory Settings page in the backend access boundary, so only roles that can open Factory Settings (Admin, Developer) can change it. Each real change writes a `settings_change` audit event in the same transaction; a no-op does not.
- Ordinary Factory Settings saves cannot change the flag.
- Turning the mode OFF stops **new** automatic allocations only. Existing loading links, saved colors and history are never changed by the switch.

## Automatic allocation

With the mode ON, a physical factory bale that is `IN_STOCK` with an ERP location is allocated when it is created by Stock Entry, and when an unallocated bale is printed or reprinted:

1. The company Priority Scan lock (advisory lock `73202`/company) is taken first, then proforma capacity locks, then order and bale rows.
2. The first active queue position whose `LOADING` order's proforma still needs the bale's article — counted **per loading** — receives it.
3. The bale is linked to the loading (`customer_order_bales`) at the proforma's per-bale or per-kg price, the loading's totals are recalculated, and the bale counts as loaded without a scan.
4. An immutable snapshot of loading, priority, color, proforma, operator and time is written to `factory_priority_scan_history` and `factory_priority_auto_allocations` (one active allocation per company/bale, enforced by a partial unique index).
5. A loading whose proforma requirement is complete leaves the queue and the next one moves up in the same transaction.
6. A bale no loading needs stays unallocated in stock and prints as an ordinary label.

Allocation never posts an inventory movement: Stock Entry receives the bale into ERP inventory once, and a V5-loaded bale stays `IN_STOCK`.

A saved snapshot is reused only while the bale is still linked to that loading. If the link was removed outside physical deletion (exchange, loading cancellation), the stale snapshot is closed with reversal metadata and the bale is treated as unallocated.

## Labels

- A4, A5 and sticker labels keep the exact ordinary layout, sizes, banners and barcodes. For an allocated bale, only the small HMD logo inside the barcode information box changes: it is replaced by an empty solid rounded rectangle filled with the bale's **saved** priority color (A4 25×14 mm, A5 22×12 mm, sticker 20×10 mm — the same size on screen and in print), with no lettering inside it. The large HMD banners are unchanged. There is no colored stripe. See [priority-scan-fixed-palette-color-block.md](priority-scan-fixed-palette-color-block.md).
- Legacy Pressing and Production finalization labels replace their small "HMD / INTERNATIONAL GROUP" text with the same 25×14 mm saved-color rectangle; ordinary bales keep the text.
- Bales without an allocation print exactly as before.
- Colors come only from the server snapshot (`#RRGGBB`, `#RGB` or a known legacy name); an unrecognized color cancels printing instead of printing a misleading label.
- Print routing (A4/A5 vs sticker, design-color picker) is the same as for ordinary labels. Zebra ZPL is monochrome, so a batch containing a priority label always uses browser printing.
- Every print surface prepares labels through the server before rendering: `/api/bale-label-prints` (prints records and allocation in one transaction), `/api/bale-label-prints/reprint`, and `POST /api/factory/customer-orders/loading-list/automatic-print-preflight-batch` (≤200 bales per atomic request; the client splits larger prints). A reprint whose audit call disagrees with the prepared label is refused.

## Physical deletion

All physical bale deletions — Stock Entry removal (list or by product), Bale History delete, single/bulk status `DELETED`, and Barcode Lookup "delete everywhere" — go through `deletePhysicalFactoryBalesTx` in one transaction:

- Rejects duplicates, unknown/foreign/already deleted bales, sold/dispatched bales, bales in a dispatch batch and bales on verified/finalized loadings; one bad bale rejects the whole batch (HTTP 4xx, nothing changed).
- Removes the bale's links to open (`DRAFT`/`LOADING`) loadings, recalculates their totals, records `customer_order_bale_removals`, and marks allocation/history rows reversed (original color and priority are kept). Links held by cancelled or deleted orders are left untouched.
- Decrements ERP location inventory once for a bale still counted there (`IN_STOCK` or `RESERVED_FOR_ORDER`), posting the canonical movement `factory-bale-removal:<company>:<bale>` first; an existing movement for that key refuses the deletion instead of decrementing twice. A bale that never had a receipt (no stock item/balance) is deleted with no ERP effect, recorded in the daybook metadata.
- Writes the permanent `factory_physical_bale_deletions` row and the `BALE_REMOVAL` daybook entry.
- Quantity removal by product never picks bales on a live loading, waste dispatch refuses loaded bales, and status edits cannot move a bale on an open loading to a non-loading status or revive a deleted bale. Generic Deleted Items restore refuses bales with a recorded physical deletion.

Removing a bale from an editable loading without deleting it returns it to stock with no ERP movement.

## Priority #1 recovery

When a loading that the system auto-completed (`updated_by_name = 'system:auto-completed'`) is still `LOADING` and again needs bales after a deletion or loading removal, it returns to Priority #1 and the rest of the queue shifts down. Bales already on other loadings keep their links and colors. Several reopened loadings are ordered by their original configuration creation time. Manually disabled, cleared, verified, finalized, cancelled or deleted loadings are never reopened. If the old color is now used by another active loading, the reopened loading receives a different current color; historic snapshots keep the original color.

## Tests

- `tests/automatic-priority-*.test.ts` (database-backed), `client/src/lib/labelHtml.test.ts`, `client/src/lib/priorityPrintPreflight.test.ts`.
- Physical printing, colour printer output and scanning printed barcodes must be verified on the factory's hardware before the mode is enabled for a company.
