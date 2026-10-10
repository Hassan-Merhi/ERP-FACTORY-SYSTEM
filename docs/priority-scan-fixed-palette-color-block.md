# Priority Scan fixed palette and color-block label integration

Implementation branch: `feat/priority-scan-fixed-11-colors-label-box` — PR #2141.

## Behavior

- The only new/edited Priority Scan colors are the 11 values in `shared/priorityScanColors.ts`, in their fixed display order. Each active company loading must have a distinct color.
- The Pending Loadings editor renders only those swatches. Previously stored non-palette colors remain visible and recorded; saving a different color selects an approved swatch.
- Moving an existing active queue position omits `color` and sends `enabled: true` and `priority`; the server preserves the existing color and colorKey. Create/re-enable/color-change requests cannot omit an approved color.
- The print renderer uses the recorded allocation color (not the current queue palette), normalizes legacy named/short HEX values safely and rejects unsafe colors.
- Where the small priority HMD logo used to appear, color-bearing labels show a plain solid rounded rectangle instead. No text or logo is inside the block. Non-priority labels keep their original logo and all other label content.
- A4 and A5 use the shared detail markup; stickers and the separate Pressing/Production label templates use the same saved-color block principle.
- Preflight and reprint audits reject stale mismatches between the prepared order/color and recorded order/color. The system does not rewrite historical colors or allocation snapshots.

## Deployment and Claude verification handoff

This phase did not run CI, tests, PDF-print verification, or perform test fixes. Claude must verify the full PR and make any corrections prior to merge, specifically:

- Update the old `client/src/lib/labelHtml.test.ts` assertions: they still expect colored HMD raster artwork and the removed `priorityLogoTextStyleAttr` helper. Expectations now must target the solid rectangle and preserve ordinary-logo assertions.
- Update `client/src/lib/priorityPrintPreflight.test.ts` fixtures: reprint audit now requires a `priorityAllocation.color` matching the prepared color.
- Review any existing Priority Scan API tests that submit arbitrary colors; newly saved colors must come from the canonical list, but historical-color reads and position-only updates must remain supported.
- Verify printing dimensions, visible background fills, scanning, historical reprints and stale snapshot refusal on A4, A5, sticker, Pressing and Production layouts.
- Run required repository tests, lint, type checking, build, security/CI and correct all issues on this same PR before merge.

No database data migration is required or authorized to recolor existing records.
