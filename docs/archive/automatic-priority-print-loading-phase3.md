# Automatic Priority Printing & Loading — Phase 3 handoff

## Status

The **new priority label templates are implemented in code** on the same `feat/automatic-priority-print-loading` branch. No print-preview rendering, hardware tests, automated tests, type checks, or CI have been executed. Claude owns verification, and the factory-wide switch remains OFF by default.

## Approved label behavior

The user's final reference replaces the earlier "many color strips" design.

- The **small HMD wordmark inside the information/barcode label** changes to the **immutable original priority assignment color** (`LabelData.priorityColor`).
- "INTERNATIONAL GROUP" below the small wordmark stays black.
- The **large HMD globe/brand artwork remains unchanged**, using the existing embedded HMD asset; it never changes to the priority color.
- Barcode payload, barcode number/reference, article, pieces, approximate weight and product name are unchanged.
- Labels without priority assignment use their **original normal template and original customer/HMD logo**. An unrelated A4 design color is not a priority color.
- Mixed batches (some priority, some ordinary) render each bale independently. The priority color does not leak into the next label.
- Reprints receive the saved allocation from Phase 2, not the current order's priority or current color. The printing functions never change allocation data themselves.

## Implemented formats

1. **A4 (210 x 297 mm)**: One page/bale, two exact 148.5 mm halves in the existing A4 layout. Each half has the unchanged large HMD brand artwork. The first half includes the information/barcode label with the small colored HMD wordmark and adjacent product text; the second half has the large product name. The old two-half page size is unchanged.
2. **A5 (148 x 210 mm)**: Two A5 pages/bale, preserving the established split print workflow. Each page carries the unchanged large HMD brand artwork. The first page also includes the information/barcode label with the colored HMD wordmark; the second has the large product name.
3. **Barcode sticker (3 x 1.97 in)**: Existing sticker dimensions, reference barcode, article and weight, with only the small HMD wordmark recolored.

The print CSS explicitly allows the priority wordmark to retain its color in print, while other printed text stays dark and barcode raster assets retain their original contrast. Large HMD artwork is not affected by the other print image-contrast filter.

## Safe source colors

`resolvePriorityLabelColor()` accepts `#RRGGBB`, `#RGB`, and a controlled set of legacy named colors (Red, Blue, Green, Orange, Yellow, Purple, Pink, etc.). The value is normalized into a safe hex CSS color; arbitrary CSS is rejected. If an assigned color is invalid, the renderer throws instead of printing a label that implies a wrong loading.

Visible product/barcode text is HTML-escaped. Priority selection and server allocation happen in other phases; only a saved allocation supplies `priorityColor`.

## Print hardware restriction

Color printing requires a color-capable printer and appropriate print settings; Zebra ZPL thermal printers are monochrome. Existing print entry points that receive `priorityColor` use the browser/PDF print route rather than sending color-demanding labels directly as monochrome ZPL. Claude must verify that operator workflows make this distinction clear on real devices and that color output is enabled.

## Changed Phase 3 code

- `client/src/lib/labelHtml.ts`: safe priority color validation, small wordmark, corrected A4/A5 artwork geometry, sticker integration, and preserving ordinary labels.
- `client/src/lib/labelHtml.test.ts`: **authored, unrun** regression tests for exact data, per-format geometry, priority color, named/hex colors, invalid colors, mixed batches, safe printed text and old templates.

Previously committed print call sites already pass the immutable server-saved priority allocation when available (Stock Entry, Stock Entry reprints, Bale History, Factory Reprint Labels and Location Inventory). Completing additional specialized print surfaces belongs to Phase 5.

## Claude acceptance checklist (do not run during implementation)

- Run relevant tests and TypeScript checks, then CI as part of Claude's eventual one-PR review.
- Verify actual browser print and print-to-PDF for A4, A5 and 3 x 1.97-in stickers, including exact margins/scale.
- Compare the printed A4 artwork and small HMD wordmark against the provided reference picture.
- Scan physical barcodes to confirm references and quiet zones remain readable.
- Try long article/product names, multiple bales, missing images, valid and invalid colors, mixed batches and OFF-mode ordinary printing.
- Verify red/blue/green from saved original assignments after queue changes and reprints.
- Ensure color is actually printed in color on target equipment, especially thermal-printing fallback behavior.

No code has been merged and no automated verification has been represented as complete.
