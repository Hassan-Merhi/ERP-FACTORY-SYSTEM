# Factory blue-theme unification — Phase 2 implementation

**Date:** 2026-11-10
**Source baseline:** `main` at `67db92acb7a3d2187bc50d9f0dba70e0f9f9d0d6`
**Scope:** Factory page/card dark backgrounds, borders, gradients and decorative panels. This is Phase 2 of the existing Factory blue-theme plan. Phase 3 inline accents/shadows and Phase 4 visual QA are separate.

## Implementation

- Converted **255** fixed blue/indigo/purple-background and border literals across **28** Factory TSX components to Tailwind arbitrary HSL values using the Factory theme's `--factory-hue`.
- For each former fixed hex shade, retained its approximate saturation and lightness, with chromatic hue provided by `hsl(var(--factory-hue) ...)`. This makes dark surfaces, card borders and gradients track Factory's centrally controlled hue.
- Includes Customer Loading and its summary cards, Invoicing, Insurance, Suppliers, Worker Attendance, Loading Dispatch and Compare, Priority Scan, Container Loading components, production comparison, invoice metrics, payroll, raw stock KPIs and shipping panels.
- Preserved distinct **green**, **red**, **amber** and **rose** colors for genuine statuses and production/category data. In particular, the Attendance absence/leave rose gradient is explicitly exempted from the new regression test.
- Did not change business logic, shipping/finance calculations, print output contracts or the separately scoped ERP and Properties theme files.

## Source-level verification

| Check | Result |
| --- | --- |
| Fixed blue/purple arbitrary hex UI classes from the targeted Factory pages | **0 remaining** |
| New Factory HSL-based dynamic arbitrary color values | **255** |
| Preserved arbitrary hex status/category colors in the same scan | **43** (19 green, 21 red/amber, 3 rose) |
| Factory theme targeted tests | **3 passed** |
| Prettier on all changed TSX/test files | **Passed** |
| Git whitespace diff check | **Passed** |
| Production Vite and server build (`npm run build`) | **Passed** |
| Generated CSS emission | **Verified** — Tailwind emitted the runtime `hsl(var(--factory-hue) ...)` values |

The static test in `client/src/styles/factory-unified-theme.test.ts` now inspects Factory TSX arbitrary card/background/border/gradient colors, while preserving the documented status-color exception.

## Remaining phases (not part of Phase 2)

**Phase 3:** Centralize remaining standalone accent and shadow literals, including `FactoryFinancialSnapshot.tsx`'s `#6366f1` accent, the purple `rgba(168,85,247,0.5)` shadow in `PressingHistoryReport.tsx`, and `FactoryContainerLoadingScan.tsx`'s fixed decorative shadow. Review the isolated pink production-target icon without remapping chart categories or semantic warning colors.

**Phase 4:** Visual check of representative Factory pages in light/dark themes and desktop/tablet/mobile layouts; runtime visual QA has **not** been performed or claimed here.

**Phase 5:** Final roll-up verification of the full Factory theme program, CI/deployment status and production.

The Phase 1 source audit is recorded in `docs/archive/factory-blue-theme-phase1-audit-2026-11-10.md`.
