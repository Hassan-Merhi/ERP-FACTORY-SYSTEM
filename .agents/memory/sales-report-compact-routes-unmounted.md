---
name: Compact Sales Report routes were unmounted
description: The built Sales Report page fetches /api/sales-report/summary etc., but only the dead stats/index.ts barrel registered them; the mounted statsRoutes.ts did not, so production showed "Sales report unavailable" while dev and the raw endpoint kept working.
---

## What happened

`build/viteSalesReportInvalidationPlugin.ts` rewrites `client/src/pages/SalesReportLegacy.tsx`
at build time — **unconditionally**, not behind `ENABLE_SALES_REPORT_BANDWIDTH` — so every
production bundle requests the compact endpoints:

- `GET /api/sales-report/summary`
- `GET /api/dashboard/sales-report-all/summary`
- `GET /api/dashboard/sales-report-comparison`

Those three lived in `server/routes/stats/salesReportBandwidthRoutes.ts`, which was registered
only by `server/routes/stats/index.ts` — a barrel **nothing imports**. The registry the server
actually mounts is `server/routes/statsRoutes.ts`. Consequences:

- The request matched no route and fell through to the SPA fallback
  (`app.use("/{*splat}")` → `index.html`, HTTP **200 + HTML**).
- `fetchSalesReportSummary` does `response.json()` on that HTML → rejects → `isError` →
  the page renders `ErrorState("Sales report unavailable")` with a `Retry report` button that
  re-runs the same 404-shaped request. Summary pills showed `$0` because they render
  `totals` from the (absent) successful payload.
- `npm run dev` shows the same failure (the Vite `transform` hook runs in dev too), but the raw
  `/api/sales-report` endpoint — the one in the page's *source* — always worked, so the query
  and the SQL were never suspects.

Fix: register `registerSalesReportBandwidthRoutes(app)` in `server/routes/statsRoutes.ts`
(before `registerStatsDataRoutes`), and reduce `server/routes/stats/index.ts` to a re-export so
two lists cannot drift again.

## Why the existing guardrail missed it

`scripts/verify-bandwidth-phase-3-sales-report.mjs` asserted the registration order **inside
`server/routes/stats/index.ts`** — the dead file — and nothing in `package.json` or CI ever ran
that script. Both problems are fixed: the verifier now reads the mounted registry (and asserts
`applicationRoutes.ts` imports it), and `verify:bandwidth` chains it after phases 1–2.

## How to apply this to any endpoint the built client fetches

`tests/sales-report-compact-routes.test.ts` runs the real build transform over the three sales
report sources, extracts every `/api/...sales-report...` URL from the **transformed** output, and
walks the live mount graph (`registerX(app)` invocations, not imports) to require each URL be
registered. Generalize the same way when a build-time plugin rewrites API paths: the invariant
must be checked against the transform output and the mounted registry, never against page source or
a sibling barrel. Route-source markers alone prove nothing (`.agents/memory/route-split-orphans.md`).
