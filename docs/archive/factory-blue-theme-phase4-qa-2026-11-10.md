# Factory blue-theme unification — Phase 4 QA handoff

**Date:** 2026-11-10  
**Scope:** Factory responsive/light/dark source contracts and browser visual QA.  
**Status:** Source regression coverage committed to `main`; **browser visual QA remains unverified**.

## Implemented on main

- Added `client/src/styles/factory-unified-theme-phase4.test.ts` with four regression checks:
  1. Factory, Properties, and ERP each import their own theme and set their own document shell marker; each theme is scoped to its own mode.
  2. Factory light and dark mode both define hue-derived semantic background, sidebar, border and focus accents and use the workspace background token.
  3. Factory phone shell retains viewport metrics, phone sheets, minimum mobile control heights and scrollable workspace.
  4. Location Inventory light/dark CSS retains Factory hue integration rather than fixed six-digit brand colors.
- Kept functional status, category, chart, real item color and document/print colors separate; no business/data behavior changed.

## Verification evidence and limits

- Inspected committed Factory/Properties/ERP shell source and all three independent theme files.
- Inspected Location Inventory CSS; its blue surfaces use `--factory-hue`.
- Source test file was committed and re-fetched from GitHub. **The tests have not been executed in this session.**
- No authorized authenticated running-app/browser session or screenshot evidence was available here. Do **not** mark light/dark/mobile visual QA as passed based on static assertions.
- No CI workflow runs were returned for the newly committed change when checked.

## Required browser acceptance matrix

For each row, verify at **mobile 390px**, **tablet 768px**, and **desktop 1440px** in **light and dark mode**, including any open dialog/dropdown.

| Factory route / feature | Visual acceptance criteria |
| --- | --- |
| Factory overview, sidebar and top bar | Blue shared brand, correct canvas/sidebar contrast, readable labels, no overflowing header |
| Location Inventory | Blue page glow, cards and selectors in both modes; mobile controls remain usable |
| Customer Loading, Container Loading Scan and Dispatch | Blue cards, stripes, shadows and scanner state; preserve operational alert colors |
| Insurance, Suppliers, Invoicing and Proformas | No remaining purple decorative panels; buttons, gradients and tables readable |
| Worker Attendance, Payroll and Production Targets | Preserve red/rose leave/absence and other status semantics; no purple ornamental backgrounds |
| Production Comparison, Pressing History and Finance Snapshot | Blue decorative shadows and indicators; charts and financial signs remain distinguishable |
| Portal dialogs, dropdown menus and overlays | Same Factory palette as page; no ERP/Properties variable leakage |
| Mode transitions Factory → Properties → ERP → Factory | Each shell restores its own CSS scope and blue theme without color carryover |

For every route/mode/viewport combination: capture a screenshot, test keyboard focus/contrast and horizontal scrolling, and record any regression with route, viewport, mode, screenshot and source file.

## Closure criteria

- [x] Phase 4 regression tests authored and committed to `main`.
- [x] Factory shell theme isolation and responsive source wiring inspected.
- [ ] Run the new Vitest file and existing `factory-unified-theme.test.ts` with a passing CI/test log.
- [ ] Complete the browser acceptance matrix with actual screenshots in light/dark and three viewport widths.
- [ ] Correct any observed rendering defects and repeat relevant screenshots.
- [ ] Confirm final deployment in Phase 5.

**Phase 4 is not certified complete** until runtime visual evidence and test execution are attached. This handoff intentionally does not claim screenshots, tests, or deployment that were not run.
