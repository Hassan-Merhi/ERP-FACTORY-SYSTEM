# Factory blue-theme unification — Phase 1 source audit

**Audit date:** 2026-11-10
**Baseline:** `main` at `262446deb643cba454176bdb7ba16603b2466552`
**Status:** Phase 1 source inventory and classification complete. **No UI colors or business logic changed in this phase.**

## Scope and counting rules

The audit read **673** Factory-related frontend source files in `client/src` (**487 TSX, 171 TS, 15 CSS**). The scope includes `pages/factory/**`, Factory-named components and modules, shared Factory shell/theme files, and Factory-specific styles. This is a static-source audit, **not** a claim that every rendered route, image, printout or runtime-injected style was visually tested.

| Finding | Baseline | Interpretation |
| --- | ---: | --- |
| Fixed hex color occurrences | **699 in 69 files** | All color roles, including neutral layouts and intentionally distinct statuses/prints |
| Hue-classified purple/pink hex occurrences | **23 in 14 files** | Includes intentional category/status/product colors; **not 23 defects** |
| RGB/HSL literal expressions surveyed | **223** | One clearly purple RGBA shadow in `PressingHistoryReport.tsx` |
| Blue/purple hex values in decorative-looking contexts | **235 in 33 files** | Review queue; many values are blue already and some are statuses/print CSS |
| Named blue/indigo/purple/violet/fuchsia/sky Tailwind utility references | **1,979 in 141 files** | Names do **not** imply purple rendering: Factory remaps these palettes to one hue |
| Pink/rose Tailwind utility references | **119 in 21 files** | Not remapped; many denote exceptions (absence, errors, warnings, product/category colors) |

The hex scan includes 3-, 4-, 6-, and 8-digit values. CSS IDs such as `#factory-dispatch-paper` were excluded, preventing misleading counts. Individual occurrences, not distinct color values, are counted. Classification used context, hue, and manual review of purple matches. Remaining ambiguous blue/neutral decorative literals are queued for review—not automatically designated bugs.

## Verified foundation — no Phase 2 changes needed

- `client/src/styles/factory-unified-theme.css`: `--factory-hue: 217` (blue) and 11 shared shades for each legacy `blue`, `indigo`, `purple`, `violet`, `fuchsia`, and `sky` utility family.
- `client/src/app/FactoryShell.tsx` imports only the Factory theme. The document-scoped `data-app-shell="factory"` variable rules allow Factory Radix portals to inherit its theme.
- `PropertiesShell.tsx` and `ErpShell.tsx` import their own `properties-unified-theme.css` and `erp-unified-theme.css`, scoped to `properties` and `erp`. **Do not merge or retheme those apps during Factory cleanup.**
- `pages/factory/FactoryLocationInventoryRedesign.css` has **71** references to `var(--factory-hue)` and **zero six-digit hex literals**. The originally reported Location Inventory CSS mismatch is addressed at source level.
- Legacy Tailwind `violet-*`/`purple-*` class names are **aliases**, not inherently visual regressions. Do not bulk-rename them without a distinct readability objective.

## Confirmed Factory UI decorative purple exceptions

These fixed decorative values bypass the Factory hue. Replace them with Factory theme tokens in **Phases 2–3**.

| Area / source | Line(s) on audited baseline | Reason | Phase |
| --- | --- | --- | --- |
| Customer Loading KPI card — `CustomerLoadingSummaryCards.tsx` | 73 | Purple dark-mode gradient `#432a70`, `#352452` | 2 |
| Insurance card — `FactoryInsurance.tsx` | 312 | Purple dark gradient `#3b265e` | 2 |
| Invoicing header — `FactoryInvoicing.tsx` | 86 | Violet/indigo gradient includes `#22143d`; examine other fixed dark gradients on lines 77–88 | 2 |
| Worker Attendance card — `FactoryWorkerAttendanceReport.tsx` | 636 | Purple dark-mode shadow/background `#302448` | 2/3 |
| Supplier card — `factory-suppliers/FactorySuppliersDirectory.tsx` | 430 | Purple dark gradient `#342051` | 2 |
| Invoice Dashboard metrics — `factoryinvoices/InvoiceDashboardMetrics.tsx` | 26 | Violet gradient `#2c1b42` | 2 |
| Production Comparison — `productioncomparison/components/PeriodOverviewCard.tsx` | 35 | Purple card gradient `#2b1a48` | 2 |
| Pressing History — `PressingHistoryReport.tsx` | 177 | Hardcoded violet `rgba(168,85,247,0.5)` shadow, despite aliased Tailwind classes | 3 |
| Finance section — `FactoryFinancialSnapshot.tsx` | 374 | Hardcoded indigo/blue accent `#6366f1` | 3 |

The first seven rows contain **eight** literal purple hex occurrences; the final two are separately detected RGBA/blue accent exceptions.

## Broader page-by-page execution checklist

**Candidate** means inspect the fixed background/accent in its real UI context before replacing it. Do not change status or export colors simply because a file appears here. The 33-file color-candidate queue includes some files below that ultimately belong in the protected-exception bucket.

### Phase 2 — backgrounds, cards, dark mode, gradients

- [ ] `FactoryWorkerAttendanceReport.tsx` — review fixed dark cards, backgrounds, shadows and attendance-status exceptions (39 blue/purple decorative-looking hex occurrences).
- [ ] `FactoryPriorityScan.tsx` — audit fixed dark overlays, blue gradients, scanner states (21).
- [ ] `factory-suppliers/FactorySuppliersDirectory.tsx` — supplier section/card gradients and violet exception (19).
- [ ] `CustomerLoading.tsx` — cards, panels, dark backgrounds and state chips (15).
- [ ] `FactoryInsurance.tsx` — dark cards, violet exception, status-color preservation (15).
- [ ] `factorycontainerloadingscan/ScannedBalesPanel.tsx` — fixed blue panels and overlays (13).
- [ ] `FactoryEmployeeAttendanceTab.tsx` — fixed gradients; **preserve rose absence/leave styling** (12).
- [ ] `FactoryInvoicing.tsx` — tab headers, invoice/proforma panel gradients (11).
- [ ] `FactoryLoadingDispatch.tsx` — blue panels and scanner workflow backgrounds (10).
- [ ] `factorycontainerloadingscan/LoadingSetupCard.tsx` — fixed setup cards/overlays (10).
- [ ] `CustomerLoadingSummaryCards.tsx` — KPI gradients and purple dark-mode card (9).
- [ ] `FactoryLoadingDispatchCompare.tsx` — comparison panel backgrounds (7).
- [ ] `ProductionComparison.tsx` — decorative comparison backgrounds (6).
- [ ] `factoryinvoices/InvoiceDashboardMetrics.tsx` — metrics backgrounds and violet variant (6).
- [ ] `productioncomparison/components/PeriodOverviewCard.tsx` — purple/dark gradient (6).
- [ ] `FactoryContainerLoadingScan.tsx` — blue header decoration and fixed dark shadows (4).
- [ ] `factoryshippingcontainers/components/ShippingDashboardOverview.tsx` — dashboard panels (4).
- [ ] `FactoryOtwTrackingTab.tsx` — tracking sections (3).
- [ ] `production-raw-stock/KpiCards.tsx` — KPI card backgrounds (3).
- [ ] `CustomerLoadingColumnsDialog.tsx` — dialog background (2).
- [ ] `FactoryLoadingDispatchCompareParts.tsx` — compare card styling (2).
- [ ] `FactoryLoadingDispatchScanner.tsx` — scanner backgrounds (2).
- [ ] `FactoryPayrollHub.tsx` — visual KPI accent (2).
- [ ] `FactoryLoadingDispatchAllocation.tsx` — allocation UI color (1).
- [ ] `FactoryLoadingDispatchLifecycle.tsx` — lifecycle UI color (1).
- [ ] `ProductionRawStock.tsx` — raw stock UI color (1).
- [ ] `factoryotwtrackingtab/components/SummaryCard.tsx` — summary card color (1).
- [ ] `factoryproformas/ProformaLinesTable.tsx` — line-table UI color (1).
- [ ] `factoryshippingcontainers/components/ShippingToolbar.tsx` — toolbar UI color (1).

### Phase 3 — direct accents and shadows

- [ ] `FactoryFinancialSnapshot.tsx:374` — replace fixed `#6366f1` with a shared Factory color.
- [ ] `PressingHistoryReport.tsx:177` — replace purple RGBA shadow with a Factory variable/appropriate blue shadow.
- [ ] `FactoryContainerLoadingScan.tsx:35–40` — review fixed decorative RGBA shadow/blue header; preserve other functional cues.
- [ ] `productiontargets/productionTargetsPremium.css:247` — decide if the isolated pink icon is decorative; do **not** rewrite category palette entries indiscriminately.
- [ ] Review UI-appropriate blue/neutral fixed hex values from the Phase 2 queue; prefer `--factory-hue`-derived or shared semantic tokens.

## Protected exceptions — explicit classification

The following are **not** grounds for making everything blue:

| Source | Fixed hue / detail | Classification and treatment |
| --- | --- | --- |
| `FactoryEmployeeAttendanceTab.tsx:83` | `#4b2135`, `#392033`, `#732f47` | Rose/absence styling; **preserve semantic red/rose** unless shown decorative in UI QA |
| `dailyproductionreport/utils.tsx:115,190,193` | `#f472b6`, `#7c3aed`, `#db2777` | Chart series/grade/category distinctions; preserve |
| `factoryattendance/utils.tsx:252` | `Leave: "#7e22ce"` | Attendance status mapping; preserve |
| `factorysheetsandsacks/utils.ts:11` | `"Purple": "#9b59b6"` | User-selectable real item color preset; preserve |
| `factorybalerelabeling/components/LabelPreviewCard.tsx:13` | `#6d28d9` | Printed/user-selected label preview fallback; review with label design, do not silently alter output |
| `productiontargets/productionTargetsPremium.css:314,596,598` | Pink category palette `#f5659a`, `#cc4b87`, `#9e2c64` | Distinct production target category; preserve |
| `dailyproductionreport/components/production-overview-premium.css:323` | `#35121e`, `#25131c` | Dark red *wipers/garbage* status card, not blue brand chrome; preserve |
| `FactoryLoadingDispatchReport.tsx` and report/image/print/WhatsApp components | Fixed paper colors and generated assets | Treat as export/print contract; do not alter output as part of UI background sweep |
| All Factory files | Red/amber/green status, danger, leave, product and chart colors | Preserve meaning and contrast, including accessibility |

## Acceptance / Phase 1 handoff

- [x] Review the latest `main` baseline and scan Factory-specific frontend sources, including TSX/TS/CSS.
- [x] Distinguish theme-aliased Tailwind class names from non-aliased fixed hex and RGB colors.
- [x] Verify the Factory hue and independent Properties/ERP theme wiring.
- [x] Verify Location Inventory's primary CSS uses the Factory hue.
- [x] Identify exact confirmed violet/purple decorative exceptions with source paths/lines.
- [x] Document broader fixed background/accent candidates and protected semantic/export exceptions.
- [x] Produce a page-by-page checklist for Phases 2–3.

**Phase 1 is complete as a static source audit.** Phases 2–3 must implement the checklist; Phase 4 must do visual light/dark/mobile testing and add TSX regression coverage; Phase 5 must verify checks, merge and deployment. No production visual certification is claimed by this Phase 1 record.
