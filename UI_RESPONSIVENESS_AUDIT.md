# UI, Scrolling and Responsiveness Audit — Desktop / Tablet / Mobile

**Date:** 2026-10-10 · **Branch audited:** `main` at `86a5aa3` · **Scope:** rendered web app (not the Capacitor builds)

## Score: **88 / 100** after Phases 1–8 (was **73 / 100** on `main` at `86a5aa3`)

| Area | Weight | Before | After | What changed / what is left |
| --- | --- | --- | --- | --- |
| Desktop (1440×900, 1920×1080) | 25 | 21 | **23** | Opaque sticky headers at the true top of the workspace, legible column labels, notes launcher inside the content column, page scroll with native wheel on every list route. Left: 10px chip/badge text (≈6 nodes per route), wide tables still clip at 1440 (now with an edge fade), no frozen reference column applied, no content max-width at 1920. |
| Tablet (768×1024, 1024×768) | 20 | 11 | **17** | Sidebar collapsed by default below 1024px (user pin remembered, parked links inert), Vouchers usable in both orientations, payroll table scrolls instead of collapsing, Properties tiles fixed, 44px header controls, theme toggle on screen. Left: wide tables scroll sideways inside the page (by design), Daybook keeps its own scroll region for windowed rendering. |
| Phone (390×844 portrait, 844×390 landscape) | 25 | 20 | **22** | Voucher title no longer clipped, Properties on the ERP phone contract (header, cards, summary grid, no floating launcher), Customers cards, POS checkout bar above the bottom nav, tab-strip and table edge fades, landscape phones keep the phone lists via `phone-land:` and hide keyboard hints. Left: landscape keeps the drawer-plus-hamburger chrome (deliberate), three Factory hubs have no title strip. |
| Scrolling behaviour | 15 | 10 | **14** | Workspace tables let the page scroll (narrow ones keep a page-sticky header), zero `calc(100vh - N)` in the client, the synthetic wheel forwarder and the body scroll-lock sweep are gone with rendered evidence, voucher pickers and chat use `dvh`. Left: wide tables cannot have both a page-sticky header and a sideways scroller. |
| Consistency and design system | 10 | 7 | **8** | One breakpoints module, `touch` and `phone-land` Tailwind variants so components declare their own touch/landscape behaviour, route-scoped overrides removed (`!important` 147 → 102, class-string selectors 53 → 1), one scoped action-row wrap rule instead of a global rule plus two undo blocks, phone bottom-sheet dialogs are the dialog primitives' own behaviour (opt-in per shell, no document marker, no `!important`), one `[role="dialog"]` catch-all instead of three competing ones, Properties shares the ERP contracts, Payroll/Invoicing hubs on `PageHeader`. Left: the card-table stylesheet, six mobile phase tests still assert source text. |
| Accessibility and touch ergonomics | 5 | 4 | **4** | Collapsed sidebar is inert, 44px header controls on coarse pointers, shortcut badges hidden on touch, launcher hidden until anchored. Left: 10px text, web fonts from the network. |

### Re-audit evidence (branch `claude/fervent-hopper-wzfayi` at `2238e0e`, same harness and seeded data as §1)

| Pass | Routes × sizes | Doc or workspace overflow | Controls off-screen | Sub-40px touch controls | Nested vertical scrollers | Wheel / swipe moved the page |
| --- | --- | --- | --- | --- | --- | --- |
| ERP (clean profile) | 16 × 6 (phone, phone landscape, tablet, tablet landscape, desktop, wide) | 0 / 96 | 0 | only the visually hidden skip link and in-table reference links | 0.13 avg (tab strips, not tables) | 25 / 25 on desktop and wide, 42 / 42 swipes on touch sizes |
| Factory | 10 × 5 | 0 / 50 | 0 | skip link only | 0 | 24 / 24 |
| Properties | 7 × 3 | 0 / 21 | 0 | skip link only | 0 | 6 / 6 |
| POS sale screen | 4 sizes | 0 | 0 | 0 on phone and tablet | — | — |

Before the phases, the same ERP matrix reported 11–23 off-screen controls per tablet route, two 32px header buttons on every touch capture, a nested scroller on every stock list route, and no page movement from a wheel on three list routes at every size. Tables that still scroll sideways: Containers OTW below 1920, and the Factory stock-entry cart, raw-stock and payroll tables at 768 (all with the edge fade, none with a trapped page scroll).

The repository's own `run-responsive-browser-smoke.mjs` now dismisses the first-run prompts; against this dev server it still reports the loading boundary on heavy routes because the per-route settle time is shorter than Vite's first transform, so the documented runbook (run it against a build) stands.

Score as it was on `main` before any change, for reference:

| Area | Weight | Score | One-line verdict |
| --- | --- | --- | --- |
| Desktop (1440×900, 1920×1080) | 25 | **21** | Polished, consistent chrome; a few real defects (sticky-header bleed, floating notes button over the sidebar, 10–11px text density). |
| Tablet (768×1024, 1024×768) | 20 | **11** | The weak viewport. Portrait keeps the 256px sidebar pinned, leaving ~440px for pages designed for desktop or phone; several screens become unusable. |
| Phone (390×844 portrait, 844×390 landscape) | 25 | **20** | ERP phone shell is excellent (bottom nav, cards, bottom sheets, keyboard-aware dialogs). Factory good. Properties/POS behind. One visible layout bug on Vouchers. |
| Scrolling behaviour | 15 | **10** | Zero horizontal overflow anywhere. But data pages use scroll-inside-scroll tables that trap the wheel/swipe, and the shell forwards wheel events synthetically. |
| Consistency and design system | 10 | **7** | Strong shared primitives, but mobile behaviour is layered on through four override stylesheets with 147 `!important` rules and class-string selectors. |
| Accessibility and touch ergonomics | 5 | **4** | Skip link, focus rings, 44px/16px on phones, reduced-motion. Tablet top bar stays at 32px targets. |

The earlier `UI_UX_AUDIT.md` is now stale on most of its structural points: `PageHeader` is used in 155 page files (was 12), the shadcn `Table` in 250, `Skeleton` in 184, and the largest page file is now 899 lines (was 7,028). Do not use that document for planning.

---

## 1. How this was measured

**Static review** of the shells (`client/src/app/*Shell.tsx`), the global and mobile stylesheets (`index.css`, `mobile-browser-compat.css`, `erp-mobile-operations.css`, `factory-mobile-operations.css`, `mobile-shell-dialogs.css`, `mobile-card-table.css`), the scroll hooks (`use-workspace-wheel-scroll`, `useGlobalScrollKeys`, `useErpScrollRestoration`, `use-dialog-scroll-fix`, `use-visual-viewport-metrics`), the UI primitives (`table`, `dialog`, `sidebar`, `core-erp-mobile`, `erp-mobile-filters`), and the 993 page files under `client/src/pages`.

**Rendered review** against a local dev server (Postgres 16, `npm run dev`) with Playwright/Chromium. Rows were seeded through the app's own fixture scripts (`prepare-erp-mobile-program-fixture.mjs` into the MAIN company; `prepare-phase9-browser-smoke-fixture.mjs` for Factory/Properties/POS companies; the Factory seeder from `verify-factory-mobile-browser.mjs`).

Viewports: phone 390×844, phone landscape 844×390, tablet 768×1024, tablet landscape 1024×768, desktop 1440×900, wide 1920×1080. Touch viewports ran with `hasTouch` and `isMobile`.

Per route and viewport the harness recorded: document and `#main-content` horizontal overflow, interactive controls outside the viewport, touch targets under 40px and inputs under 16px (touch viewports), text under 12px, nested vertical scroll containers, horizontal scrollers, fixed elements, table/card mode, whether a wheel (desktop) or swipe (touch) in the middle of the page actually moved the page, console errors and a screenshot.

Routes: 32 ERP/POS/Factory/Properties routes in the main matrix; 14 Factory routes and 8 Properties routes in dedicated passes under the developer fixture user; a data-backed pass on 11 ERP list routes. Roughly 300 rendered page captures in total.

Caveat: the only console errors on every route were Vite HMR WebSocket noise from the dev server (`WebSocket closed without opened`), not application errors. Under heavy parallel load the dev server occasionally served the "Loading workspace" boundary; those captures were discarded and the affected viewports re-shot in a single-browser clean pass.

---

## 2. What is genuinely good

- **No horizontal page overflow at any size.** Across every capture, `document.scrollWidth` never exceeded the viewport and `#main-content` never overflowed sideways. This is rare for an ERP of this size and is the single strongest result.
- **Correct scroll architecture.** `html/body` do not scroll; the shell is `h-full overflow-hidden` with `main#main-content` as the one vertical scroller, `overscroll-contain`, safe-area padding, `100dvh` on `#root` below 768px, and `scrollbar-gutter: stable`. Back/forward restores the workspace scroll position (`useErpScrollRestoration`).
- **ERP phone shell is a real mobile product, not a shrunken desktop.** Simplified top bar, five-item bottom nav with safe-area padding, "More" page sheet, phone filter sheet (`ErpMobileFilters`), `Table mobileLayout="cards"` that restacks rows as labelled cards, dialogs that become bottom sheets lifted above the keyboard (`--erp-keyboard-inset` from `visualViewport`), sticky dialog header/close and pinned action rows, 44px controls and 16px inputs enforced on phones.
- **Factory phone floor screens** (Stock Entry, Raw Stock, Production Report) are tight: pinned workflow bar, focused scanner input, scrolling tab strips with snap, hover-only actions made visible on coarse pointers.
- **Desktop chrome is coherent.** One "Business OS" brand block per module with a module accent, grouped collapsible nav with pinned/recent sections, command palette with shortcut hint, dark mode, print styles, RTL hardening, reduced-motion support.
- **Rendered mobile gate exists in CI** (`run-responsive-browser-smoke.mjs`, `verify-factory-mobile-browser.mjs` at six sizes with seeded data, strict table mode, Escape/drawer/keyboard checks).

---

## 3. Findings by viewport

### 3.1 Desktop (1440×900 and 1920×1080) — 21/25

Measured: 0 document overflow, 0 controls outside the viewport, wheel moved the page on every route where the page itself was taller than the viewport, except the three stock routes below.

1. **Sticky table header is translucent and rows bleed through it.** `TableHeader` uses `bg-muted/95 backdrop-blur` (`client/src/components/ui/table.tsx:140`). Once a table region scrolls, the row passing under the header is readable through it ("Leather belts" showing through "Name" on `/stock?tab=items`; "Household linen" through "Code" on `/stock?tab=query`). Use an opaque `bg-muted`/`bg-card` header, or put the blur on a pseudo-element with a solid base.
2. **Floating notes button overlaps the sidebar.** `UserNotesPanel` renders a `fixed z-50` launcher at bottom-left (`client/src/components/UserNotesPanel.tsx:173`). At 1440×900 it sits on "Intel Settings" / "Settings" in the Factory and ERP sidebars and over the user avatar on tablets. It should be anchored to the content column (`left: var(--sidebar-width)` offset or bottom-right) or hidden while it overlaps `[data-sidebar="footer"]`.
3. **Wide tables scroll sideways even at 1440.** Containers OTW shows 14+ columns and clips at "Docs"; the column-visibility control exists but no first column is frozen and there is no end-of-row shadow, so users do not notice there is more. Consider a frozen `#`/reference column and a right-edge fade on `[data-table-scroll-region]`.
4. **Scroll-inside-scroll on data pages.** `Table` caps its region at `max-h-[70vh]` by default (`table.tsx:108`). On `/stock?tab=items`, `/stock?tab=query` and `/combined-inventory` a wheel over the table scrolls the table, not the page; the page footer and anything under the table is only reachable by moving the pointer off the table. This is also why `nestedVScrollers` averaged 0.45 per desktop route. Prefer page scroll with a sticky header (`usesParentScroll`), and reserve the capped region for dialogs.
5. **Density.** Desktop routes average 9 visible text nodes under 12px (`text-[10px]`/`text-[11px]` appear 497 times across 144 page files). KPI chips, table captions and badge labels at 10px are hard to read on 1080p at 100% scaling.
6. **1920 wide:** content stretches to the full width with no `max-w` container on most pages, so KPI tiles and filter rows become very long, and Containers OTW still clips at "BL Docs" with 20+ columns. Low severity; a `max-w-[1600px]` content column would tidy this.
7. **Table header legibility.** Column headers are 10px uppercase `text-muted-foreground` on `bg-muted`; on the 1920×1080 Containers OTW capture the labels are barely distinguishable from the background. Raise to 11–12px and use `text-foreground/80`.

### 3.2 Tablet (768×1024 portrait, 1024×768 landscape) — 11/20

Portrait is the single worst experience in the product. `useIsMobile` is `< 768`, so an iPad in portrait is treated as desktop: the 256px sidebar is pinned open by default (`SidebarProvider defaultOpen = true`), the content column is ~440px, and pages fall through to their desktop layout because the phone CSS (`≤639px`) does not apply either.

1. **Vouchers is not usable in portrait** (`/vouchers`, `/properties/vouchers`, `/factory/vouchers`). The voucher-type list and the entry form share a two-column grid; the Account and Amount inputs in the entry table render as "Typ" and "0.(" — about 50px wide — and the totals footer stacks awkwardly. Landscape is broken differently (item 8). Phones are fine because they use the bottom-sheet entry editor; desktop is fine from ~1280px.
2. **Factory Payroll workers table collapses** (`/factory/payroll-hub?section=workers`). The table has no minimum width, so eight columns are squeezed into 440px: header labels overlap into an unreadable string and the worker name wraps one character per line. Needs `min-w-[…]` on the table (so it scrolls) or a card layout below `lg`.
3. **Containers OTW and other wide tables clip without affordance.** The table region scrolls horizontally but the sticky header ends mid-word ("ETA DAS") and nothing signals that there are 10 more columns.
4. **Properties KPI tiles overflow their card.** On `/properties/rentals?tab=shops` the combined "Outstanding / Credit" tile's text escapes the card border, and tiles in the 3-column grid have unequal heights with large empty areas.
5. **Touch targets on the top bar stay at desktop size.** The user menu and company switcher are 32px tall on every tablet capture (flagged on 11/11 ERP, 12/14 Factory and 7/8 Properties routes). The 44px rules only apply below 768px or on `(pointer: coarse)` inside `#main-content`; the header is outside `#main-content`.
6. **POS checkout bar covers the sidebar.** On `/pos` at 768×1024 the pinned totals/Checkout bar is `position: fixed` across the full viewport width, so it paints over the pinned sidebar's user footer instead of only the content column. It should be `sticky` inside `#main-content` (as the ERP `mobile-action-bar` is) or offset by `var(--sidebar-width)`.
7. **Swipe scrolls the table, not the page.** On `/stock?tab=items`, `/stock?tab=query` and `/combined-inventory` the touch-scroll test moved the inner table region while the page stayed still (same root cause as desktop finding 4, but worse on touch because there is no pointer to move off the table).
8. **Landscape (1024×768) is mostly the desktop layout with less vertical room** — Daybook, lists and dashboards are fine. But Vouchers breaks here too: at exactly `lg` the page switches to its three-column layout (type list, form, account picker) inside a 744px column, so "Pay From" wraps one letter per line, the title is clipped by the date input, and the entry table clips at "Run…". The 70vh table cap also leaves ~5 rows visible under the filters, so most list pages become scroll-in-scroll immediately.
9. **Theme toggle is pushed off-screen at 768px in Factory and Properties.** The top bar keeps the search pill, bell, user menu, company switcher and theme toggle on one `flex-nowrap` row; with the sidebar pinned the last control lands at x=767 and is clipped by the shell's `overflow-hidden`, so dark mode cannot be toggled from an iPad in portrait in those two modules (ERP hides the user menu at this width, which is why its toggle still fits). Measured on all 8 Factory and 7 Properties tablet captures.

Recommended fix set for tablet: default the sidebar to collapsed (`offcanvas`) below `lg` (1024px) and let the user pin it; treat `768–1023px` as a first-class breakpoint in the three cramped screens above (Vouchers two-column → stacked; Payroll table → `min-w`; Properties KPI grid → 2 columns); apply the 44px/16px rules to the header on `(pointer: coarse)` as well.

### 3.3 Phone portrait (390×844) — part of 20/25

Measured on ERP, Factory, Properties and POS routes: 0 overflow, 0 controls outside the viewport, 0 inputs under 16px, touch targets under 40px limited to the visually hidden skip link (false positive) and a few in-table reference links.

1. **Payment/Receipt voucher header truncates the title.** On `/vouchers` the title "Payment Voucher" is clipped to "P / V" behind the date input: the header row keeps a fixed `w-[9.5rem]` date input and a `shrink-0` effective-date control beside the title (`client/src/components/vouchers/PaymentReceiptTab.tsx` ~line 320–370). The row needs `flex-wrap` or a stacked phone layout. This is the one visible layout bug on the ERP phone shell.
2. **Tab strips clip the last tab with no fade** (`/inventory` "Contai…", `/factory/production-report`). They scroll correctly, but a right-edge gradient or the shared `Tabs` keep-active-in-view behaviour would make it discoverable.
3. **Empty-state tables do not switch to cards.** `/parties?tab=customers` with no rows shows the desktop table header with the empty state under it; with rows the same page becomes a scrolling 3-column table rather than cards (`mobileLayout` is not set there). Minor inconsistency with `/stock?tab=items`, which uses cards.
4. **KPI chip rows wrap unevenly** ("Receivable / Payable" on Customers; the five tiles on Containers OTW leave an orphan). Using the shared `CoreErpFilterGrid`-style auto-fit grid for KPI chips would remove the orphans.
5. **Properties shell** has no bottom nav and keeps the floating notes button on phones (it covers the "What We Owe" card on the dashboard); ERP and Factory hide that button below `sm`. Properties also lacks the phone filter sheet and card tables.
6. **POS** (`/pos` after choosing a location) is good on phones: full-width scanner input, stacked location/date/credit/cash controls, a pinned "items · qty · total · Checkout" bar. It has no page title or Back control, and the "Select Cash" account select truncates to "Sele…" from tablet width down; otherwise it is the best non-ERP phone screen.

### 3.4 Phone landscape (844×390) — part of 20/25

The shell correctly treats a short coarse-pointer screen as phone for the sidebar (it slides over) and the Factory floor lists, but **the top bar and page bodies render the desktop layout**: the "Ctrl /" keyboard hint, 32px header buttons and five-across KPI tiles appear on a 390px-tall touch screen, and the 70vh table cap leaves two rows visible. The voucher page is correct in landscape (the header no longer clips), but the sticky totals footer paints a ghost of the "0 lines" text under "LINES" where two layers overlap.

---

## 4. Scrolling behaviour — 10/15

What works: single scroll container with safe-area padding; `overscroll-contain`; `100dvh`; scroll restoration on Back; arrow/PageUp/PageDown/Home/End handled only when a scrollable target exists (`useGlobalScrollKeys`); phone dialogs and sheets sized to the visible viewport and lifted above the keyboard; focused fields scrolled back into view when the keyboard opens; `prefers-reduced-motion` honoured.

Where it falls short:

1. **Nested scroll regions on list pages** (desktop finding 4, tablet finding 7). The default 70vh table cap means most data pages have two vertical scrollers. On touch this is a scroll trap; on desktop it is a wheel trap. The `Table` already has a `usesParentScroll` mode; it should be the default on pages and the cap the exception.
2. **Synthetic wheel forwarding.** `useWorkspaceWheelScroll` attaches a non-passive `wheel` listener to the whole shell and, when the pointer is not over a nested scroller, calls `preventDefault()` and `main.scrollBy({ top: e.deltaY, behavior: "auto" })`. This defeats native smooth scrolling and trackpad inertia (each event becomes a discrete jump) and forces the browser to wait on JS for every wheel event. Native bubbling already scrolls `main` when the pointer is over non-scrollable content; the hook should be removed or limited to the specific case it was added for (wheel over a fixed overlay that is not a scroller).
3. **Body scroll-lock recovery.** `useDialogScrollFix` watches the DOM and force-clears `overflow`/`pointer-events` on `body` after dialogs close. It exists because rapid open/close of Radix dialogs leaves the page frozen; the symptom is patched rather than the dialog lifecycle fixed (unmounting while the close animation runs).
4. **Magic viewport math.** 36 page files size regions with `calc(100vh - 300px)`-style literals (`CombinedInventory.tsx`, `StockOTW.tsx`, `LocationVouchers.tsx`, `SalesReportItemsView.tsx`, …). These assume a header height, break when the top bar wraps, and use `vh` rather than `dvh` so they are wrong behind the mobile URL bar.
5. **Translucent sticky headers** (desktop finding 1) make the scroll state itself look broken.

---

## 5. Consistency and the design-system layer — 7/10

Strengths: one `PageHeader`, one `Table`, `CoreErpPage/Header/Actions/FilterGrid`, `ErpMobileFilters`, `ErpMobileRecordCard`, `KPICard`, shared sidebar primitives, module accent tokens (`--nav-*`), tabular numerals everywhere, dark-mode tokens.

Weaknesses:

1. **Four override stylesheets carry the mobile behaviour.** `index.css` (36 `!important`), `mobile-browser-compat.css` (29), `erp-mobile-operations.css` (38), `factory-mobile-operations.css` (6), `mobile-shell-dialogs.css` (13), `mobile-card-table.css` (19) — 147 in total. Many rules target Tailwind class strings through attribute selectors (`[class*="opacity-0"][class*="group-hover"]`, `[class~="md:hidden"]`, `.flex.gap-2 { flex-wrap: wrap }`), and later files exist partly to undo earlier ones (`factory-mobile-operations.css` re-sets `flex-wrap: nowrap` on columns that the `index.css` wrap rule broke; three different `[role="dialog"]` max-height rules compete). This works today but is fragile: a class rename or a Tailwind upgrade silently changes phone layouts.
2. **The three breakpoints disagree.** `useIsMobile` is `<768`, the ERP phone query is `≤639 or (coarse and ≤500px tall)`, `index.css` mobile block is `≤768` (inclusive, so it overlaps Tailwind `md:` at exactly 768px), `mobile-browser-compat.css` uses `≤767` and `≤639`. The tablet gap in §3.2 is a direct consequence.
3. **Module header grammar differs.** ERP pages use `PageHeader` with the accent bar and Back; Factory and Properties pages mostly keep their legacy headers (icon-above-title, no Back, actions in a wrapped row), so the same user sees three title styles when switching modules.
4. **Hard-coded fixed widths.** `w-[Npx]` appears 601 times in 201 page files and `min-w-[Npx]` 258 times; 79 grids use 3+ fixed columns with no responsive variant (`SpOffloadDialog.tsx`, `OpeningStockDetail.tsx`, `SalaryOverviewSection.tsx`, …). These are the next tablet/phone squeeze points.
5. **Tests assert source text, not behaviour.** The `tests/ui/mobile-responsive-phase*.test.ts` files read CSS/TSX files and `expect(...).toContain("flex-direction: column !important")`. They pin the implementation rather than the outcome; the Puppeteer smoke scripts are the real safety net and should be the ones extended.
6. **The documented manual gate fails on a fresh profile.** Running `scripts/run-responsive-browser-smoke.mjs` with credentials against this build reports "#main-content is missing or invisible" on every phone route, because the first-run language onboarding dialog (a full-screen sheet below 640px) is open and Radix marks the page behind it inert. The CI job uses `run-phase9-language-browser-smoke.mjs` instead, so CI is unaffected, but the runbook in `docs/mobile-tablet-web-regression.md` should either dismiss the dialog or seed the `application-language-onboarding` flag.

---

## 6. Accessibility and touch — 4/5

Present: skip link, `:focus-visible` outline fallback, `touch-action: manipulation`, 44px controls and 16px inputs on phones, hover-only row actions made visible on coarse pointers, `aria-label` on the workspace and filter regions, `prefers-reduced-motion`, RTL layer.

Gaps: 32px header controls on tablets (above); 10px text in chips and badges; Google Fonts loaded from the network so the offline/PWA path falls back to system fonts with different metrics; `Skip to main content` is the only landmark link on the phone shell (no "back to top" for long card lists).

---

## 7. Priority fix list

| # | Fix | Impact | Effort |
| --- | --- | --- | --- |
| 1 | Default the sidebar to collapsed below `lg` (1024px); keep user pin via the existing cookie. | Fixes most tablet-portrait pain at once. | Small (`SidebarProvider defaultOpen` + breakpoint). |
| 2 | Vouchers: key the two- and three-column layouts off the content width (container query or `xl:`) instead of `md:`/`lg:`; give entry inputs a minimum width; wrap the header row on phones. | Removes the three voucher defects (tablet portrait inputs, tablet landscape wrap, phone title clip). | Small–medium. |
| 3 | Make `Table` page-scroll (`usesParentScroll`) the default on pages; keep the 70vh cap for dialogs. | Removes wheel/swipe traps on every list page. | Medium (audit the 250 Table call sites that rely on the cap). |
| 4 | Opaque sticky table header. | Fixes read-through on all scrolled tables. | Trivial. |
| 5 | Move/hide the notes launcher when it overlaps the sidebar footer; hide it on Properties phones like ERP/Factory. | Removes an overlap visible on nearly every desktop/tablet screen. | Small. |
| 6 | Give the Factory Payroll table a `min-w` so it scrolls instead of collapsing. | Fixes the unreadable tablet table. | Trivial. |
| 7 | Apply the 44px/16px rules to the header on `(pointer: coarse)` regardless of width. | Tablet touch ergonomics. | Trivial. |
| 8 | Retire `useWorkspaceWheelScroll` (or scope it to the one overlay it was written for). | Native smooth scrolling and inertia on desktop. | Small; verify the original issue is gone. |
| 9 | Replace `calc(100vh - Npx)` literals with flex `min-h-0` layouts or `dvh`. | Correct heights behind mobile URL bars and wrapped headers. | Medium (36 files). |
| 10 | Consolidate the four mobile stylesheets into component-level responsive classes over time; stop adding attribute-selector overrides. | Long-term robustness. | Large; do incrementally per screen. |

---

## 8. Evidence index

The rendered harness, result JSON and screenshots were produced in the session scratchpad and are summarised here rather than committed (≈300 PNGs). Key captures referenced above:

- `tablet /vouchers`, `tablet /properties/vouchers` — truncated entry inputs.
- `tablet /factory/payroll-hub?section=workers` — collapsed table.
- `tablet /` (Containers OTW) — clipped wide table; `tablet /properties/rentals?tab=shops` — KPI overflow.
- `desktop /stock?tab=items`, `tablet /stock?tab=query` — translucent sticky header; nested scroll.
- `phone /vouchers` — clipped "Payment Voucher" title; `phone-land /` — desktop chrome on a touch phone.
- `desktop /factory/stock-entry`, `desktop /stock?tab=items`, `tablet /parties?tab=customers` — notes launcher over the sidebar.
- `phone /`, `phone /stock?tab=items`, `phone /daybook`, `phone /factory/stock-entry` — the good ERP/Factory phone baseline.

Aggregate numbers (clean single-browser passes):

| Viewport | Routes | Doc overflow | Controls off-screen | Tables overflowing / total | Wheel or swipe moved the page | Avg text <12px |
| --- | --- | --- | --- | --- | --- | --- |
| phone 390×844 (ERP data pass) | 11 | 0 | 0 | 0 / 2 (1 card table) | 7 / 8 | 2.3 |
| phone 390×844 (Factory) | 14 | 0 | 0 | 0 / 2 (2 card tables) | 6 / 6 | 1.6 |
| phone 390×844 (Properties) | 8 | 0 | 0 | 0 / 0 | 3 / 3 | 2.6 |
| tablet 768×1024 (ERP data pass) | 11 | 0 | 0 | 1 / 6 | 4 / 7 | 8.7 |
| tablet 768×1024 (Factory) | 14 | 0 | 0 | 0 / 4 | 2 / 2 | 3.7 |
| desktop 1440×900 (ERP data pass) | 11 | 0 | 0 | 1 / 6 | 3 / 6 | 9.3 |
| desktop 1440×900 (Factory) | 14 | 0 | 0 | 0 / 6 | 1 / 1 | 5.2 |

"Wheel or swipe moved the page" counts routes where the page was taller than the viewport and a scroll gesture in the centre of the page moved `#main-content`; the misses are the nested-table pages described in §4.

Clean single-browser ERP pass (14 routes: Containers OTW, Vouchers, Daybook, Stock, Inventory, Parties, Agents, Sales Tools, Stock Query, My Settings, POS Dashboard, POS, Containers):

| Viewport | Doc overflow | Controls off-screen | Tables overflowing / total | Wheel or swipe moved the page | Avg text <12px | 32px header controls |
| --- | --- | --- | --- | --- | --- | --- |
| tablet 768×1024 | 0 | 0 | 1 / 5 | 6 / 8 | 6.9 | on every route |
| tablet landscape 1024×768 | 0 | 0 | 1 / 5 | 7 / 9 | 7.0 | on every route |
| desktop 1440×900 | 0 | 0 | 1 / 5 | 5 / 7 | 7.3 | n/a (pointer) |
| wide 1920×1080 | 0 | 0 | 0 / 5 | 4 / 6 | 7.3 | n/a (pointer) |

The misses in "moved the page" are `/stock?tab=items` and `/stock?tab=query` at every size (nested table region), and Containers OTW is the one overflowing table at every size below 1920.

Clean single-browser Factory pass (8 routes: Production Report, Stock Entry, Raw Stock, Invoicing, Daybook, Payroll, Stock Allocation, Vouchers):

| Viewport | Doc overflow | Controls off-screen | Tables overflowing / total | Swipe or wheel moved the page | Avg text <12px | Sideways scrollers (tab strips) |
| --- | --- | --- | --- | --- | --- | --- |
| tablet 768×1024 | 0 | 1 per route (see note) | 1 / 4 | 4 / 4 | 5.9 | 5 |
| tablet landscape 1024×768 | 0 | 0 | 0 / 4 | 5 / 5 | 6.1 | 3 |
| wide 1920×1080 | 0 | 0 | 0 / 4 | 1 / 1 | 6.6 | 0 |

Note on "controls off-screen" at 768×1024: the one control is the theme toggle in the Factory and Properties top bars, measured at x=767 with a 40px width, so it sits almost entirely past the right edge (see tablet finding 9). The notes launcher measured at (20, 904) 40×60 against a sidebar footer at (0, 924) 255×100, confirming the overlap in desktop finding 2.

---

## 9. Remediation phases, easiest to hardest

Each phase is independently shippable and verifiable with the existing rendered smoke scripts. Effort is for one engineer. "Done when" is what the viewport harness or a manual check must show.

### Phase 1 — CSS-only fixes (half a day) — DONE

Shipped on this branch. What actually landed, with the deviations from the plan:

- Opaque `TableHeader` (`bg-muted`) in the primitive, **plus** the 46 pages that overrode it with their own translucent `bg-muted/40`–`/50` or `bg-background/95 backdrop-blur` sticky headers (`tailwind-merge` let those overrides win, so fixing the primitive alone changed nothing on Stock Items).
- `TableHead` at 11px / `text-foreground/80` at every width.
- Factory payroll workers table: `min-w-[56rem]`; the outer panel already scrolled sideways.
- 44px header controls on `(pointer: coarse)`, scoped to `[data-slot="app-top-bar"]`. That pushed the row ~20px over at 768px, so the actions group is now shrinkable, the company switcher truncates, the search pill is pinned, and the user name shows from `lg` (role from `xl`) instead of `md`. Result: no control past the viewport on any ERP, Factory or Properties tablet capture.
- Tab-strip edge fade driven by a small `useScrollOverflowProbe` hook (one capture-phase scroll listener + ResizeObserver per shell) that sets `data-scroll-overflow` on `.erp-mobile-scroll-tabs` and the shared `TabsList`; the mask only applies while the strip can scroll. Unit-tested.
- POS payment row spans the full width from `sm`, so the cash-account select no longer shrinks to "Sele…".

Verified with the rendered harness: tablet captures report 0 off-screen controls and 0 sub-40px header buttons; `/stock?tab=items` header is opaque at 1440; related vitest suites (21 files) and `tsc --noEmit` pass.

No component logic changes; every item is a class or a few lines of CSS.

| Item | Change | Done when |
| --- | --- | --- |
| Opaque sticky table header | `client/src/components/ui/table.tsx:140` — replace `bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80` with solid `bg-muted` (keep `sticky top-0 z-30`). | Scrolled rows no longer read through the header on `/stock?tab=items`. |
| Table header legibility | Same file: header cells `text-[10px]` → `text-[11px]`, `text-muted-foreground` → `text-foreground/80`. | Headers readable on the 1920 Containers OTW capture. |
| Factory payroll table | Add `min-w-[56rem]` to the workers `<Table>` (or `className` on the table element) so it scrolls instead of collapsing. | 768×1024 `/factory/payroll-hub` shows a sideways scroller, no overlapping headers. |
| Header touch targets on tablets | In `mobile-browser-compat.css`, extend the `min-height: 2.75rem` rule that currently targets `#main-content` controls to `header :is(button, [role="button"], a[href])` under `(pointer: coarse)`. | User menu and company switcher measure ≥44px on every tablet capture. |
| Theme toggle off-screen at 768px | In `AppTopBar.tsx`, let the actions group wrap (`flex-wrap`) or hide the user-name label below `lg` as ERP already does. | No control past the viewport edge on Factory/Properties tablet captures. |
| Tab-strip edge fade | Add a right-edge gradient mask (`mask-image: linear-gradient(to right, #000 90%, transparent)`) to `.erp-mobile-scroll-tabs` and `[data-factory-scroll-tabs]` when scrollable. | "Contai…" on `/inventory` phone shows a visible fade instead of a hard cut. |
| POS "Select Cash" truncation | Give the cash-account `SelectTrigger` `min-w-[9rem]` and let the row wrap below `md`. | Label fully visible at 768 and 390. |

### Phase 2 — Floating and fixed elements (half a day) — DONE

Shipped on this branch:

- **Notes launcher** keeps itself inside the content column: once the workspace mounts (it retries, because the panel mounts on idle and can beat the lazy shell on heavy routes) it moves any position left of `#main-content` to the column's edge, re-checks on sidebar expand/collapse via a ResizeObserver, and defaults 170px above the bottom so it clears sticky action bars. Measured at x=272 next to a 256px sidebar on every ERP, Factory and Properties tablet/desktop capture (was x=20, over the sidebar footer).
- **Properties phones** hide the launcher and offer "My notes" in the workspace menu, as ERP and Factory already did (`PropertiesShell` now sets `data-app-shell="properties"`).
- **POS checkout bar** is a sticky footer of the POS scroller instead of a viewport-fixed bar. Under the ERP shell the `/pos` canvas route now fills the workspace (`WorkspaceRouteBoundary fill`), so the bar pins to the bottom of the content column: it no longer paints over the sidebar on tablets, and on phones it sits above the ERP bottom nav instead of covering it.
- **Voucher totals footer** is opaque (`bg-card`), so the Payment Total card no longer ghosts through it in phone landscape.

Verified with the rendered harness on phone, phone landscape, tablet and desktop; `tsc --noEmit`, prettier, eslint and the related vitest suites (16 files) pass. One source-text test was updated for the new sticky contract.


| Item | Change | Done when |
| --- | --- | --- |
| Notes launcher overlap | `UserNotesPanel.tsx:173` — position relative to the content column (`left: calc(var(--sidebar-width) + 1rem)` when the sidebar is expanded, or move to bottom-right above the chat bubble), and hide below `sm` in the Properties shell as ERP/Factory already do. | Launcher rect does not intersect `[data-sidebar="footer"]` or nav links at 1440×900, 768×1024, or Properties phones. |
| POS checkout bar | Make the totals/Checkout bar `sticky bottom-0` inside `#main-content` (reuse `.mobile-action-bar`) instead of `position: fixed` across the viewport. | Bar no longer paints over the sidebar at 768×1024. |
| Voucher landscape ghost footer | Give the sticky totals footer an opaque `bg-background` and remove the duplicated "lines" layer. | No ghost text under "LINES" at 844×390. |

### Phase 3 — Breakpoints and sidebar default (one day) — DONE

Shipped on this branch:

- **Sidebar starts collapsed below `lg`.** `SidebarProvider` reads the `sidebar_state` cookie first (the user's last choice, which was written but never read before) and otherwise pins the sidebar only from 1024px. A tablet in portrait now opens with the full ~740px content column: the Vouchers entry inputs are ~260px wide instead of 50px, the account picker stacks below the form, and the Factory payroll table has room. The user can still pin it with the toggle, and that choice sticks. The collapsed off-canvas sidebar is also `inert`, so its parked links (previously 11–23 focusable controls 244px past the left edge) leave the tab order and accessibility tree.
- **Phone CSS stops at 767px.** The `index.css` phone block and the two blocks in `erp-mobile-operations.css` / `factory-mobile-operations.css` that undo it moved from `max-width: 768px` to `767px`, so nothing from the phone layer applies at the same width as Tailwind `md:`. The ERP-only rule that hid the user name between 768 and 1023px was removed; Phase 1 already moved the name to `lg`.
- **One breakpoint source.** `client/src/lib/breakpoints.ts` exports the phone/mobile/pinned-sidebar widths and media queries; `useIsMobile`, `useErpPhoneLayout` (which re-exports `ERP_PHONE_LAYOUT_QUERY`) and the sidebar read from it. The stylesheets cannot import it (no custom-media PostCSS step), so the module documents the 639/767/1023 values the CSS must match.

Verified with the rendered harness: tablet portrait captures show the sidebar collapsed and the content column full width on ERP, Factory and Properties; tablet landscape and desktop keep it pinned. `tsc --noEmit`, prettier, eslint and the related suites (22 files) pass; a unit test covers the cookie-over-viewport default.


| Item | Change | Done when |
| --- | --- | --- |
| Sidebar collapsed by default on tablets | `SidebarProvider`: `defaultOpen = window.matchMedia("(min-width: 1024px)").matches` (respect the existing `sidebar_state` cookie when set). | 768×1024 captures open with the content column full width; user can still pin. |
| 768px overlap | `index.css` mobile block `@media (max-width: 768px)` → `767px` so it no longer overlaps Tailwind `md:` at exactly 768. | No rule from the phone block applies at 768 wide. |
| Single breakpoint source | Export `PHONE_QUERY`, `TABLET_QUERY` from one module and use them in `use-mobile.tsx`, `use-erp-phone-layout.ts` and the CSS custom media (via PostCSS `@custom-media` or documented constants). | One place defines 639/767/1023. |

### Phase 4 — Vouchers layout (one to two days) — DONE

Shipped on this branch:

- **Phone header.** The title block in the payment/receipt header keeps a 9rem minimum, so the already-wrapping row now moves the date input to the next line instead of painting it over "Payment Voucher".
- **Three columns from `xl`, not `lg`.** The form / account-picker split in the payment/receipt, journal, stock-transfer and stock-adjustment forms moved from `lg:` (1024px, where a pinned sidebar leaves ~450px for the form) to `xl:`. At 1024×768 the picker now stacks under a full-width form; at 1440 and above the layout is unchanged.
- **Entry table minimum widths.** The desktop entries table gives Account a 10rem and Amount a 6.5rem minimum and scrolls sideways below that instead of squeezing the inputs to "Typ" / "0.(".
- Tablet portrait was already fixed by Phase 3 (sidebar collapsed → full-width form). No container-query plugin is installed, so the split is keyed off viewport breakpoints; the Tailwind `container-queries` plugin remains the better long-term tool if more pages need content-width layouts.

Verified with the rendered harness on all four voucher tabs at phone, tablet, tablet landscape, desktop and wide (ERP), plus Factory and Properties vouchers: no overflow, no off-screen controls, title and inputs readable at every size. `tsc --noEmit`, prettier, eslint and the voucher suites pass.


The single page with defects at three sizes.

| Item | Change | Done when |
| --- | --- | --- |
| Phone header | `PaymentReceiptTab.tsx` header row: `flex-wrap`, date input `w-full sm:w-[9.5rem]`, effective-date control on its own line below `sm`. | "Payment Voucher" fully visible at 390 wide. |
| Tablet columns | Drive the type-list / form / account-picker split by content width, not viewport: wrap the page in `@container` and use `@lg`/`@xl` container queries (Tailwind `container-queries` plugin), or move the split from `md:`/`lg:` to `lg:`/`xl:`. Stack the type list above the form when the content column is under ~900px. | At 768×1024 and 1024×768 with the sidebar pinned, inputs are ≥160px wide and "Pay From" is on one line. |
| Entry inputs | `min-w-[10rem]` on the account cell and `min-w-[7rem]` on the amount cell; let the entry table scroll sideways rather than shrink. | No "Typ" / "0.(" at any size. |
| Apply to all three modules | The same components serve `/vouchers`, `/factory/vouchers`, `/properties/vouchers`; verify all three. | Rendered smoke passes on all three at the six sizes. |

### Phase 5 — Properties and Factory phone parity (two to three days) — DONE (scoped)

Shipped on this branch:

- **Properties now uses the ERP phone contract.** The rental and payments-log pages were already built on the shared ERP components but gated them to ERP/Factory mode; Properties mode now gets the same `PageHeader` (accent bar, icon, subtitle), the phone card lists with one primary action plus an Actions menu, and the two-column summary grid. `useMobileCardTable` accepts Properties as a card-table mode, so every `mobileLayout="cards"` table restacks on Properties phones as it does in ERP and Factory.
- **Properties KPI tiles.** The combined Outstanding/Credit card that overflowed at tablet widths is two tiles; the desktop grid is six equal tiles (`2 / sm:3 / xl:6`).
- **Customers** uses card rows on phones (the empty state and the populated list now match Stock Items) and lays its KPI chips out as a two-column grid below `sm`, so no chip is orphaned.
- **Containers OTW** KPI tiles: an odd last tile spans the phone row instead of sitting alone.
- **Factory hubs:** Payroll & Benefits and Invoicing render their title through the shared `PageHeader` inside the hub strip. The Parties, Bales and Containers hubs have no title strip at all (tabs only), so they were left as they are; converting them is a design decision for the Factory owners rather than a parity fix.

Verified with the rendered harness on Properties (phone, tablet), ERP Customers and Containers (phone) and the two Factory hubs (phone, tablet, desktop): no overflow, no off-screen controls, cards and headers present. `tsc --noEmit`, prettier, eslint and the related suites (18 files, ~700 tests) pass; one card-table test was updated to expect Properties cards and to use POS as the non-card mode.


| Item | Change | Done when |
| --- | --- | --- |
| Properties KPI tiles | Replace the ad-hoc 3-column grid on rentals/dashboard with the shared `KPICard` grid (`grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3`), split the combined Outstanding/Credit tile into two. | No text outside card borders at 768; no orphan tiles at 390. |
| Properties lists | Add `mobileLayout="cards"` to rental and payment tables; wrap filters in `ErpMobileFilters`. | Phone captures show cards and a filter sheet like ERP. |
| Header grammar | Adopt `PageHeader` (accent bar, Back, meta line) on Factory and Properties top-level pages instead of the legacy icon-above-title block. | Same title treatment across the three modules. |
| Empty-state cards | `/parties?tab=customers`: set `mobileLayout="cards"` so empty and populated states match Stock Items. | Phone capture shows the card empty state. |
| KPI chip rows | Use an auto-fit grid for chip rows on Customers/Containers. | No orphan chips at 390. |

### Phase 6 — Table scroll model (three to five days) — DONE

Shipped on this branch:

- **Page scroll is the default for workspace tables.** `Table` now picks a scroll mode: `page` inside `#main-content` (the table runs its full height and the page scrolls), `parent` when the element directly above it already scrolls, and `capped` (the old 70vh region) inside dialogs, sheets, outside a workspace, or when the caller passes its own cap. In page mode a ResizeObserver measures the table: one that fits is left unclipped so its sticky header sticks to the page; one wider than its box keeps a sideways scroller. `data-scroll-mode` on the region makes the mode visible to tests and the harness.
- **Sticky headers stick at the true top.** The workspace padding moved from the scroll container (`main`) onto the route content, so a page-sticky table header or toolbar sits at the top edge of the scrollport instead of 24px below it with rows showing through the gap.
- **Raw table scrollers** (Stock Items, Stock Query, Optional Vouchers, Workers roster, Factory allocation and container lists, Properties rentals) carry `data-horizontal-scroll`, and a scroller whose content fits is un-clipped by CSS so its header sticks to the page too; the overflow probe restores the scroller the moment columns outgrow it.
- **Edge fade** on table regions and marked scrollers that still hide columns (same `data-scroll-overflow` mechanism as the tab strips); the Containers OTW table now fades at "Truck #" instead of ending in a hard cut.
- **`stickyFirstColumn`** is available on `Table` (frozen first cell with an opaque background and a hairline shadow). It is not applied anywhere yet: the Containers table's first column is the row number, so freezing it adds nothing until the columns are reordered.
- **`calc(100vh - N)` is gone from `client/src`.** Thirty-nine files changed: list-page caps were removed outright (the page scrolls), and the genuine full-height panels (voucher account pickers, chat, POS sale grid, account groups split pane) use `dvh`. Daybook keeps its own capped regions because its bounded-window renderer, wired in by `build/vitePhase1PaginationPlugin.ts`, listens to those regions' scroll events; the plugin's match strings were updated to `dvh` alongside.

Measured after the change on 10 ERP routes × 4 sizes plus 6 Factory and 2 Properties routes: nested vertical scrollers on list routes went from 1 to 0; a wheel in the middle of `/stock?tab=items`, `/stock?tab=query` and `/combined-inventory` now moves the page at 1440 and 1920 (it moved nothing before); a swipe does the same at 768. No horizontal overflow anywhere.


| Item | Change | Done when |
| --- | --- | --- |
| Page scroll by default | In `table.tsx`, make `usesParentScroll` the default for tables rendered inside `#main-content`, keep the 70vh cap only inside dialogs/sheets or when `maxHeight` is passed explicitly. Audit the 250 call sites; most need nothing, a few long reports may want an explicit cap. | Wheel/swipe in the middle of `/stock?tab=items`, `/stock?tab=query`, `/combined-inventory` moves the page; `nestedVScrollers` = 0 on list routes. |
| Frozen reference column + edge shadow | Add `data-sticky-first-column` support (already partly present per CSS comments) and a right-edge shadow on `[data-table-scroll-region]` while `scrollLeft < max`. | Containers OTW keeps `#`/Container visible while scrolling sideways. |
| Remove `calc(100vh - N)` literals | Replace the 36 occurrences with flex `min-h-0` layouts or, where a cap is really needed, `dvh` with a shared `--workspace-chrome-height` token. | `grep -r "100vh" client/src/pages` returns 0. |

### Phase 7 — Scroll and dialog plumbing (three to five days, needs regression care) — DONE

Shipped on this branch:

- **`useWorkspaceWheelScroll` removed** from all four shells and deleted. Native wheel scrolling moves the workspace on every route where the page is taller than the viewport (verified at 1440 and 1920), with trackpad inertia and smooth scrolling intact and no non-passive wheel listener on the shell.
- **`useDialogScrollFix` removed.** A Playwright stress run opened and closed the New Customer dialog 25 times, a third of them mid-open-animation, then changed route with it open. With the hook's MutationObserver neutralised, `body` was never left with `overflow` or `pointer-events` set, before or after the hook's 350ms sweep window, so Radix cleans up on its own in the current versions and the body-wide attribute observer is gone. One source-text test that asserted the hook's observer configuration now asserts the hook is not mounted.
- **Phone landscape top bar.** Keyboard-shortcut badges are hidden on coarse pointers, so a landscape phone no longer shows "Ctrl /"; the 44px controls from Phase 1 already apply there. The full phone-variant header (no sidebar trigger, bottom nav) was deliberately not extended to landscape: with 390px of height the bottom nav would cost a quarter of the screen, and the sidebar drawer plus hamburger is the better fit.

Verified with the rendered harness on ERP, Factory and Properties at phone, phone landscape, tablet, desktop and wide; `tsc --noEmit`, prettier, eslint and the affected suites (≈30 files, ~1,100 tests) pass, plus a new unit test for the Table scroll modes.


| Item | Change | Done when |
| --- | --- | --- |
| Retire `useWorkspaceWheelScroll` | Remove the non-passive wheel listener; verify the original symptom (wheel not reaching `main` before a click) is gone. If one overlay still needs it, scope the listener to that overlay. | Smooth scrolling and trackpad inertia on desktop; no `preventDefault` on wheel in the shell. |
| Fix dialog lifecycle instead of `useDialogScrollFix` | Find the dialogs unmounted mid-close (rapid open/close, route changes while open) and keep them mounted until `onAnimationEnd`; then delete the MutationObserver hook. | Body never left with `overflow: hidden` after 50 open/close cycles; hook removed. |
| Phone landscape top bar | Apply the phone top-bar variant (no shortcut hint, 44px controls) when `ERP_PHONE_LAYOUT_QUERY` matches, not only below 640px. | 844×390 capture shows the simplified bar. |

### Phase 8 — Consolidate the mobile layer and the tests (two to four weeks, incremental) — IN PROGRESS (three increments shipped)

Shipped on this branch:

- **Named variants instead of attribute-matched overrides.** Tailwind gained `touch` (`(hover: none) and (pointer: coarse)`) and `phone-land` (short coarse-pointer screens) screens. The 44 hover-revealed row controls declare `touch:opacity-100` / `touch:visible` themselves; the nine landscape-phone list/table pairs declare `phone-land:block` / `phone-land:hidden`; the opening/closing stock grids and the Settings two-column editors carry their own responsive classes. The route-scoped `[data-erp-route="…"] [class*="…"]` rules, the ERP and Factory hover blocks, the shared attribute rule and the duplicated ERP touch floors were deleted: `!important` 147 → 122, class-string selectors 53 → 9. The `index.css` `.flex.gap-*` wrap rule and its undo blocks stay for a later increment because every page row depends on them.
- **Tests:** the four source-text tests that pinned the removed rules now assert the component contract (the variant on the control, the page classes, the absence of the override), and the Table scroll modes, overflow probe and sidebar default have behaviour tests. The remaining `mobile-responsive-phase*` files are still source-text assertions.
- **Smoke runbook:** `run-responsive-browser-smoke.mjs` dismisses the language onboarding and daily-rate prompts after login.

Second increment:

- **One action-row wrap rule.** The global `index.css` rule that wrapped every `.flex.gap-*` box below 768px, and the ERP and Factory blocks that undid it on columns, the sidebar and sheets, are replaced by one rule in `mobile-browser-compat.css`: rows wrap, columns (`flex-col`) and `flex-nowrap` rows do not, columns that become rows at `sm`/`md` do. The selectors name Tailwind's generated classes (`.sm\:flex-row`) rather than substrings of the class attribute. The rule had to leave `index.css`: that file's `@apply flex flex-col … gap-3` makes Tailwind copy every rule naming those classes with `.empty-state` swapped in, so a `:not(.flex-col)` there compiled to `:not(.empty-state)` and wrapped nearly every column (the Factory stock-entry page grew to 521px on a 390px phone during this work). A new test compiles both stylesheets with the project's PostCSS pipeline and asserts, against the output the browser receives, that rows wrap and columns and nowrap rows never do. `!important` 122 → 120, class-string selectors 9 → 5 (the four left are the dialog slot selectors).
- **Properties phone dialogs.** `mobile-shell-dialogs.css` and the visual-viewport hook now cover the Properties shell too, so its dialogs open as bottom sheets sized to the visible viewport like ERP and Factory (Add Shop at 390×844: full width, rounded top, actions on screen).
- **Tests:** the Phase 5 tables/data-lists test renders the Table, pagination, data-list and horizontal-scroll primitives and asserts their roles, names, descriptions, touch sizes, keyboard scrolling and the absence of network calls, instead of reading source text.

Verified with the rendered harness: ERP (6 routes), Factory (5) and Properties (3) at phone, phone landscape and tablet report no document or workspace overflow and no off-screen controls; `tsc --noEmit`, prettier, eslint and the frontend suites pass.

Third increment:

- **Phone bottom sheets belong to the dialog primitives.** `DialogContent`, `AlertDialogContent`, their headers, footers and close control now carry the phone-sheet presentation as their own classes (anchored above the keyboard, sized to the visible viewport, rounded top, sticky title/close/actions, two actions on one row), switched by `usePhoneSheet()`: a shell opts in with `PhoneSheetDialogs` (ERP, Factory, Properties), and the phone media query decides. The sheet classes come after the caller's, so per-dialog desktop sizing (`max-w-2xl`, `max-h-[90vh]`, `w-[95vw]`) is replaced wholesale on phones without `!important`. React context reaches portalled dialogs, so the `html[data-app-shell]` gating and the 13 `!important` rules of `mobile-shell-dialogs.css` are gone; what remains of that file (now imported by the primitive, not the shells) is the `:has()` rule that pins the button-only action rows of dialogs that predate `DialogFooter`. Tables inside a phone sheet let the sheet scroll (`Table` picks its parent mode there) and bottom sheets sit above the keyboard through the sheet variant itself.
- **One dialog catch-all.** The three competing `[role="dialog"]` sizing rules (index.css ≤767, mobile-browser-compat.css ≤639 and landscape, all `!important`) are one non-important rule in `mobile-browser-compat.css` that exempts phone sheets; the primitives already size themselves, so the catch-all only serves popovers and legacy modals. The Radix hidden-select pin moved there too, unscoped.
- **Tests:** the Phase 4 forms/dialogs test renders dialogs inside and outside a phone-sheet shell at phone and desktop widths and asserts the presentation (sheet vs centred, caller classes replaced, sticky parts, two-action row, `p-0` frames left alone), alert dialogs, sheets, a table inside a sheet, form grids and select controls, instead of reading source text.

Verified: ERP New Customer (a pre-`DialogFooter` dialog), Properties Add Shop and Factory Print Settings open as full-width bottom sheets at 390×844 and 844×390 with the title, close control and actions pinned; the same dialog is the centred modal at 1440×900; the ERP, Factory and Properties matrix at phone, phone landscape and tablet reports no overflow and no off-screen controls; `tsc --noEmit`, prettier, eslint and the full frontend suite (240 files) pass.

Not done (next increments): fold `mobile-card-table.css` into the table primitive, and convert the six remaining `mobile-responsive-phase*` source-text tests.


| Item | Change | Done when |
| --- | --- | --- |
| Move overrides into components | Screen by screen, replace rules in `erp-mobile-operations.css`, `factory-mobile-operations.css` and the `index.css` phone block with responsive Tailwind classes on the components themselves; delete each rule as its screen is converted. Start with the route-scoped `[data-erp-route="…"]` rules (they map 1:1 to a page). | `!important` count across the six stylesheets drops from 147 to under 30; no `[class*=…]` attribute selectors remain. |
| Replace source-text tests | Convert `tests/ui/mobile-responsive-phase*.test.ts` from `toContain("…css…")` assertions to rendered checks (jsdom with `matchMedia` mocks for layout toggles; the Puppeteer smoke for geometry). | Tests fail when a phone layout breaks, not when a comment is edited. |
| Smoke runbook | Make `run-responsive-browser-smoke.mjs` dismiss the language onboarding dialog (or seed its localStorage flag) so the documented manual gate passes on a fresh profile. | Script exits 0 against a fresh user on `main`. |

Expected score after each phase (same rubric): Phase 1–2 → ~78, Phase 3–4 → ~84, Phase 5 → ~87, Phase 6–7 → ~92, Phase 8 → ~95.
