# Live ERP + Factory Navigation Usage Study — 2026-10-26

Source: confirmed Render workspace **My Workspace**; production service **system** (GitHub repo `Hassan-Merhi/ERP-FACTORY-SYSTEM`, branch `main`), primary Postgres instance **database** (Oregon). Queries were read-only, with no production writes, CI, deployment, or authentication impersonation.

Observation snapshot: approximately 2026-10-26 06:16 UTC. `user_activity_log` contained **3,445 route-change rows** recorded since 2026-09-26, spanning **24 distinct users**, **11 companies**, and **122 raw routes**. Counts can shift with ongoing use and scheduled pruning. In the **last 14 days**, 2,852 route-change events from 23 users and 11 companies were present; **2,099** were within the last seven days at the initial snapshot.

## Crucial methodology and limitations

- `server/routes/userPresenceRoutes.ts` inserts into `user_activity_log` **only when the authenticated presence PATCH has `type: "route_change"`**, not on heartbeats. Client behavior may produce repeat or skipped navigation events. These are not verified human sessions or business transactions.
- `server/services/presenceMaintenance.ts` enforces **default 30-day retention and the latest 200 rows per user**, pruning every ten minutes. At inspection time 13 of 24 users had at least 200 events (a transient maximum of 217 before pruning). This is a **recent, truncated sample**, not comprehensive long-term adoption. Zero recorded navigations is NOT proof of nonuse.
- Dynamic detail URLs count as distinct raw routes, so `/factory/sales/pending-invoices/:id/verify`, etc. split traffic across IDs. Aggregate by canonical route pattern before future rankings.
- Grouping by company type is more meaningful than mixing ERP/Factory/retail/POS since permissions and workflows differ.
- Render request metrics and request logs confirm significant active backend traffic; they mainly capture API polling, screen-feed heartbeats, static assets, bots, etc., **not dependable per-page human views**.
- The Oct 24 spike reflects an unusually large number of recorded route changes. Do not use that single day to justify deletion.
- Source code on `main` and the live deploy SHA may lag new changes in this feature branch. Avoid interpreting route instrumentation added after the live deploy as already deployed.

## Last 14-day events by company type

| Company type | Route-change events | Users | Companies |
|---|---:|---:|---:|
| ERP | 1,557 | 17 | 7 |
| Factory | 1,128 | 10 | 1 |
| Supplier Partner | 96 | 6 | 1 |
| Retail | 68 | 2 | 1 |
| Properties | 3 | 1 | 1 |

## Critical operational paths — last 14 days

| Route | Events | Distinct users |
|---|---:|---:|
| `/factory/stock-entry` | 452 | 7 |
| `/` (varies by app/company mode) | 386 | 17 |
| `/pos` | 377 | 15 |
| `/factory/sales/loading/new` | 209 | 4 |
| `/factory/production-report` | 136 | 7 |
| `/daybook` | 115 | 4 |
| `/pos-price-list` | 113 | 6 |
| `/factory/invoicing` | 103 | 6 |
| `/vouchers` | 94 | 9 |
| `/location-inventory` | 81 | 8 |
| `/factory/location-inventory` | 39 | 6 |
| `/factory/bales-hub` | 19 | 6 |

KEEP critical operations intact, including price-list use by POS users. Move shortcuts into context only if equally reachable in the needed user role; no removal of business functionality.

## Lower navigation counts — investigate and consolidate rather than delete

| Route | Last 14 days | Distinct users |
|---|---:|---:|
| `/supplier-profit-check` | 5 | 1 |
| `/optional-vouchers` | 3 | 1 |
| `/pos-item-replacement` | 3 | 1 |
| `/stock-in-sales-report` | 1 | 1 |
| `/properties/rentals` | 1 | 1 |
| `/properties/analytics` | 1 | 1 |
| `/factory/contacts` | 0 | 0 |
| `/factory/sheets-sacks` | 0 | 0 |
| `/item-market-analysis` | 0 | 0 |
| `/accounting/dashboard` | 0 | 0 |
| `/accounting/rollout` | 0 | 0 |
| `/factory/intelligence/dashboard` | 0 | 0 |
| `/factory/intelligence/kpis` | 0 | 0 |
| `/factory/intelligence/financial-hub` | 0 | 0 |
| `/factory/intelligence/production-hub` | 0 | 0 |

Many of the final entries are developer-only or feature-flagged; zero navigations may simply reflect inaccessible screens. Avoid functional deletion without independent usage and business-purpose review.

## Additional evidence

- `/inventory`: 45 route changes, 4 users; `/stock`: 20 changes, 3 users. Combine navigation carefully, retaining deep links.
- `/factory/daybook`: 8 changes, 3 users; this was registered both pinned and grouped. The duplicate grouped link was removed in Phase 1 while the pinned entry and route were retained.
- `/factory/payroll-hub`: 33 route changes from just one user. A single-user, high-frequency business workflow may still be mission-critical.
- Retail recorded 18 navigations to `/retail/pos` and 10 to `/retail/inventory`, so mode-specific UX needs preserving.

## Decision for implementation

**Navigation-first, retention-safe cleanup**. Prioritize duplicated links and mismatched role visibility. Merge low-traffic standalone pages into existing hubs using redirects and preserving accounting/API behavior. Leave main operational routes untouched. Do not delete source components or tables based solely on navigation counts.

Re-run the same aggregate queries after Claude checks and deployment if a longer comparison is desired; a proper future usage study should use a purpose-built, aggregated, privacy-preserving view with sufficient retention. Never promise full coverage from this currently capped activity log.

## Phase impact

- Phase 1: complete duplicate cleanup and permission-consistent navigation source inspection.
- Phase 2 live usage study: **completed with retention/coverage caveats**; no telemetry installation was required because the live DB already contains route-change data.
- Phases 3–8: prioritize by the evidence above, not arbitrary screen names.
