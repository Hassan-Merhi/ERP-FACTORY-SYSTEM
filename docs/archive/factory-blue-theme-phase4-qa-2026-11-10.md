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

## Live deployment inspection (2026-11-10)

- Render service `system` (`https://erp-pos-system-copy.onrender.com`) was live at commit `a38227c178b849c5a99b5b277024e8ab9e3cb4ef`, older than the Phase 4 commits. Its deployment is manually triggered; new Phase 4 code was **not** certified as deployed.
- A read-only browser visit to that service redirected to `/login`. The visible username/password login screen gated Factory production, inventory and all internal routes.
- No authorized signed-in browser context was available. Accordingly the Phase 4 cross-device visual matrix could not be executed. Do not treat viewing the login screen as successful Factory UI testing.
- Tests remain committed but not executed with a captured test log in this session.

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

## Authenticated live browser follow-up (2026-11-10)

A saved browser profile allowed a read-only authenticated inspection on the Render `system` service. The tester selected the Factory company using the company selector and confirmed the Factory shell was rendered. **This service was running commit `a38227c`, not the later Phase 4 test commits**; runtime results therefore certify the older deployed code only, not the latest `main`.

### Observed Factory routes and palette

| Route | Actual browser evidence | Limit |
| --- | --- | --- |
| `/factory/location-inventory` | Location selector, 1 location, search, MHD view and Excel export visible; light background and blue primary accents | A separate run toggled light/dark successfully, but did not cover three viewport widths |
| `/factory/production-report` | Overview metrics and production graphs rendered | Light theme only |
| `/factory/invoicing` | Proformas/Invoices/Container Loadings/Pending Loadings/Priority Scan tabs rendered | Light theme only |
| `/factory/suppliers` | Supplier list, balances and section highlights rendered | Light theme only |
| `/factory/payroll-hub?section=workers&tab=workers` | Workers table rendered including RTL names | Light theme only |
| `/factory/containers-hub` | Factory containers UI opened, distinct from ERP `/containers` | Viewport matrix not performed |

In the observed Factory pages, primary navigation and decorative accents were blue. No prominent purple Factory card/background regression was confirmed. A separate orange/purple company-switcher icon and a purple-tinted Customers tab were observed; these should be classified before any change because they may be identity/category accents rather than Factory-branded page surfaces.

### Outstanding certification gaps

- Explicit 390px/768px/1440px browser resizing was not supported by the available browser automation. **No mobile/tablet/desktop viewport matrix was completed.**
- Light/dark toggle worked in a focused Factory shell visit; **full dark-mode route matrix was not completed**.
- No screenshot artifact was captured for each route/mode/viewport.
- No Vitest execution log was captured for the committed Phase 4 tests.
- Latest `main` changes were not deployed or runtime-tested. Do not claim deployment.

**Disposition:** Partial live QA completed, no confirmed broad blue/purple regression in sampled Factory routes; Phase 4 final certification still depends on tests and full responsive/dark-mode coverage.

## Follow-up verification of remaining QA gates (2026-11-10)

### Executed source assertions — 9/9 passed

An independent in-session JavaScript assertion pass read current `main` copies of all three mode shells, all three unified theme stylesheets, Factory Location Inventory CSS, and the Phase 4 test source directly from GitHub. The following nine focused assertions passed:

1. Factory shell/theme isolation and blue hue.
2. Properties shell/theme isolation and blue hue.
3. ERP shell/theme isolation and blue hue.
4. Presence of Factory light/dark semantic theme blocks.
5. Light-theme background/sidebar/border/focus tokens derive from Factory hue.
6. Dark-theme background/sidebar/border/focus tokens derive from Factory hue.
7. Factory workspace reads the semantic background variable.
8. Factory shell includes phone-sheet/viewport and mobile control-size hooks.
9. Location Inventory uses hue-derived styling, dark styling and no fixed six-digit hex colors.

**Important:** These were source assertions executed in the connector orchestration runtime, **not** the Vitest suite, frontend build, or browser rendering tests. No full project checkout or npm dependencies were available in the local runtime; GitHub commit status returned a Vercel success context but no captured test-suite result for the current documentation commit. Therefore the Vitest acceptance requirement remains open.

### Dark-mode and viewport attempt

An additional authenticated browser automation was launched to visit the six Factory routes in dark mode. That run redirected to `/login` and could not reuse the previously successful authentication context. No dark-mode route images or QA measurements were obtained in that attempt. The earlier successful run established that the Factory light/dark toggle works on Location Inventory, but it did not certify all routes in dark mode.

The connected browser automation does not expose explicit 390px/768px/1440px viewport resizing. **Mobile/tablet visual acceptance and screenshot artifacts remain unverified.** Avoid treating responsive class names as visual evidence.

### Updated Phase 4 status

- [x] Independently executed 9 focused source checks against the current `main` files (all passed).
- [x] Browser smoke-tested selected Factory routes in light mode and toggled Location Inventory light/dark.
- [ ] Execute and capture a passing Vitest log for the checked-in Phase 4 and prior Factory theme test files.
- [ ] Complete authenticated multi-route dark-mode screenshot testing.
- [ ] Complete actual 390px/768px/1440px mobile/tablet/desktop screenshot acceptance matrix.

Phase 4 **is not fully certified** on this evidence. Do not change the checklist to completed without actual test and browser artifacts.

## Isolated test-and-render verification (2026-11-10, additional pass)

An isolated Vercel sandbox checked out the current public `main` branch and installed locked NPM dependencies using `npm ci --ignore-scripts`. The actual Vitest frontend suite was executed:

```text
node node_modules/vitest/vitest.mjs run --config vitest.config.frontend.ts client/src/styles/factory-unified-theme.test.ts client/src/styles/factory-unified-theme-phase4.test.ts
Test Files 2 passed (2)
Tests      8 passed (8)
Exit code  0
```

The initial run exposed four fixed `dark:bg-[#101c34]` surfaces in Factory dispatch finance components newly added after the earlier color migration. The four files were fixed on `main` using `dark:bg-card`:
- `FactoryDispatchOrderFinancialReview.tsx`
- `FactoryLoadingDispatchFinance.tsx`
- `FactoryLoadingDispatchPoExport.tsx`
- `FactoryLoadingDispatchPostingPanel.tsx`

Focused tests were rerun after these fixes and then again after formatting the Phase 4 test assertion; all 8 passed on both reruns. The Phase 4 test file passes Prettier.

A real headless Chromium run loaded the current `factory-unified-theme.css` into an isolated representative workspace DOM. For **390px**, **768px**, and **1440px**, separately in **light and dark** mode, all 6 combinations confirmed:
- `--factory-hue` is `217`;
- workspace computed backgrounds are valid (`rgb(248, 249, 252)` light and `rgb(19, 22, 27)` dark);
- Factory container stripe gradients resolve;
- no horizontal overflow **in that isolated workspace fixture**.

These are measured browser rendering results, **not authenticated real-page visual QA**. The fixture does not include actual dynamic Factory pages, dialogs, data tables or mobile navigation. Screenshot files were generated in the isolated sandbox at `/tmp/factory-theme-{mode}-{width}.png`, not promoted as user-visible downloadable artifacts.

`npm run check` (full TypeScript type-check) exited 137 due to sandbox memory exhaustion, so no passing type-check is claimed. This was a separate broad check, not the focused theme test suite.

### Acceptance state
- [x] Actual Factory theme Vitest suite: 8/8 passing.
- [x] Fix four newly introduced hardcoded dispatch-finance dark surfaces.
- [x] Measured 390/768/1440 light/dark **theme CSS fixture** in Chromium.
- [ ] Authenticated business-page dark-mode screenshot matrix across the representative Factory routes.
- [ ] Authenticated business-page layout checks at 390/768/1440 including nav, dialogs and tables.
- [ ] Verify the updated `main` revision on the deployed service.

**Do not mark Phase 4 certified on these isolated fixture results alone.**

## Final focused build verification (2026-11-10)

An isolated Vercel sandbox pulled `main` at `3ba1eee3d658309a6bcb6ff0a890cbb2626cf8c7` and executed `npm run build` (production Vite client, server bundle and runtime dependency checks). **Exit code 0**, including successful transformation of **6,001 modules**. A pre-existing Vite warning about a mixed static/dynamic import in `daybookPaginationClient.ts` was emitted; it was not a build failure.

The same sandbox earlier verified the focused Factory theme Vitest suite at **8/8 passing**. The whole-project TypeScript check was killed for memory (exit 137) and remains unverified. The four newly introduced hardcoded dark card backgrounds were fixed directly on `main`.

A further saved-browser attempt still reached `/login`. The authenticated live Factory route × dark mode × viewport screenshot matrix therefore **remains incomplete** even though the isolated CSS fixture passed all 6 combinations. Production deployment of this revision is separately unverified; do not claim it is live.

**Closing decision:** All accessible Phase 4 source/build/theme-fixture checks completed and passing. Final real-app visual certification remains open until a persistent authorized browser session provides authenticated screenshots at target widths/modes.

## Authenticated dark-mode verification after reauthorization (2026-11-10)

The user reauthorized the saved web browser session. Multiple read-only browser visits confirmed authentication as an Admin in **HMD INT GROUP - BEIRUT**, with actual Factory routes rendered rather than ERP pages.

### Focused toggle diagnosis

- On `/factory/production-report?tab=production`, the real `data-testid="button-theme-toggle"` was clicked successfully.
- The HTML root changed from `class="light"` to `class="dark"`; the workspace/sidebar/topbar changed to their dark visual surfaces. The earlier broad-run toggle failure was not reproducible in this focused check.
- One browser run's restoration report was internally inconsistent about the post-restoration mode; do not assert the user's final preference based on that report. A subsequent route run explicitly confirmed `html.dark`.

### Authenticated Factory dark-mode smoke matrix

| Route | Result in live dark-mode browser | Qualification |
| --- | --- | --- |
| `/factory/location-inventory` | Rendered; navy/dark-blue cards, readable text, no visible clipping | Browser reported purple-looking sidebar/nav glow, despite blue-themed CSS source; investigate separately if this remains in a newer deployed revision |
| `/factory/invoicing` | Rendered; dark blue/gray surfaces, no visible clipping | No exact mobile/tablet width check |
| `/factory/suppliers` → `/factory/parties?tab=suppliers` | Rendered; dark-blue cards and intentionally different green/amber semantic supplier indicators | No exact mobile/tablet width check |
| `/factory/production-report` | Rendered; production charts, metrics and readable dark surfaces | No exact mobile/tablet width check |
| `/factory/containers-hub` | Rendered; navy cards and white/light-gray text, blue active accents, no visible overflow | Full page inspected in separate targeted run |
| `/factory/payroll-hub?section=workers&tab=workers` | Rendered 87-row worker table in dark mode; text and borders readable; vertical scrolling expected, no visible horizontal overflow | Full workers view inspected in separate targeted run |

The earlier multi-route browser run reported a **measured 1069×975 viewport**. A subsequent focused run described desktop width as approximately 1440px without showing an exact measured dimension; do not use that approximation as exact acceptance evidence.

No business records were edited. The inspector reported no major dark-mode card/text contrast failures across these sampled routes. One report described a purple-looking active-navigation glow while the source theme aliases purple/violet utility colors to `--factory-hue`; no hardcoded culprit has been confirmed from that visual description alone.

### Remaining acceptance limits

- The current browser tool does not provide explicit resize to 390px or 768px while preserving the authenticated session; **actual logged-in Factory mobile/tablet route screenshots remain unverified**.
- Six isolated Chromium tests at 390/768/1440 in light/dark verified only the Factory CSS fixture, not actual authenticated page content.
- The focused Factory Vitest suite previously passed 8/8 and `npm run build` succeeded. The separate whole-project TypeScript attempt exited 137 (memory); it was not certified as passed.
- The Render live revision and `main` were not asserted equal; this run does not certify production deployment of the newest source changes.

**Phase 4 disposition:** Source and build verification complete; representative live Factory **desktop dark-mode smoke checks complete**. Exact authenticated mobile/tablet route matrix and full screenshot evidence remain an open acceptance gate. Do not mark Phase 4 fully certified until those checks are performed.
