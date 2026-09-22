# Wave 7 — Production Certification & Final System Validation

Date: 2026-09-21, extended 2026-09-22
Repository HEAD certified: `claude/wave-7-certification-n3op1s`, branched from `6ecbd80` (`origin/main`)
Production service: Render `system` / `srv-d6kibgtactks739u7vl0` (Oregon, standard plan)
Production database: Render `database` / `dpg-d75mfh0ule4c73ctksfg-a` (PostgreSQL 18, `basic_1gb`)

## Scope and honesty boundary

This certification was produced from a remote container with **read-only** access to
production (Render metrics, logs, deploy history) and full access to a locally built
and booted copy of `main`. No deploy, write, or configuration change was made to
production.

Three classes of requested evidence could not be produced here and are marked
**NOT CERTIFIED** rather than estimated:

- a one-hour production RAM soak under controlled load;
- real user traffic percentiles beyond what Render already records;
- physical iPhone/Android device testing.

The 2026-09-22 extension seeded the repository's own disposable-database fixtures
locally, which made the realtime and browser-flow suites runnable after all. Those
phases moved from NOT CERTIFIED to PASS on real evidence, and four checks that were
already red on `main` before this wave were found and fixed. See **Second pass**.

Where a local measurement stands in for a production one, it is labelled as local.
Local runs used PostgreSQL 16 against a scratch database; production runs PostgreSQL 18.

---

## Phase 1 — Production deployment verification

| Check | Result |
|---|---|
| `main` contains Waves 1–6 | PASS |
| Production deployment uses latest `main` | **FAIL** |
| Build succeeds | PASS |
| Runtime starts successfully | PASS |
| Background jobs start once | PASS |
| No duplicate schedulers | PASS |
| No startup crashes | PASS |
| No startup errors | **FAIL** → fixed, see Fix 1 |
| Database connects, pool initialises | PASS |
| Migration mismatch | PASS (with note) |

### Production is not running the certified code

The live release reports `buildVersion: c2a1163f`. `main` is at `6ecbd80`. Production is
**68 commits behind**, with no divergence (`c2a1163` is an ancestor of `main`).

Those 68 commits contain essentially the entire Wave 6 body of work — every
`perf(wave6)` memory-bounding change (bounded TTL caches, capped undo retention,
released abandoned queue waiters, retired idle scraper browsers, hardened export
buffer cleanup, enriched runtime memory profiling) plus the `e1e719f` Wave 6 merge.

The service has `autoDeploy: no` and `autoDeployTrigger: off`, so it does not pick up
`main` automatically; the last four deploys were all `trigger: manual`.

**Consequence: any production metric in this report measures pre-Wave-6 code.** Waves 1–6
cannot be certified *in production* until a deploy happens. This is the single blocking
item for the whole wave.

### Startup log review

Startup is otherwise clean and well ordered: schema guards verify and report, the
company-scope RLS bridge installs 9 policies across 9 forced tables, the DB pool warms
on attempt 1, and schedulers register exactly once:

- `All scheduled jobs registered` — 7 jobs, once
- `Location stock WhatsApp scheduler registered` — once

`instance_count` is 1 for the entire observed window, so no duplicate scheduler can arise
from horizontal scaling.

One genuine error appeared on every production boot (see Fix 1).

### Notes

- Production runs with `RUN_STARTUP_MIGRATIONS=false`; runtime schema is maintained by
  the idempotent `startup-ensure` bridges instead. This is deliberate and consistent
  across boots, not a mismatch. The separate cold-start gap for a brand-new empty
  database remains as documented in `docs/fresh-db-bootstrap.md`.
- `render.yaml` had drifted from the live service and has been reconciled — see
  **Second pass, Fix 6**. It previously declared the `starter` plan with a
  `basic-256mb` database and a 384/448 MB memory guard, against a live service on
  `standard` with a `basic_1gb` database and a 1200/1500 guard, so applying it would
  have downgraded production.
- Puppeteer scrapers are disabled in production (`skipping Chrome download`), so the
  Wave 6 Maersk/ParcelsApp browser-lifecycle fixes are inert there.

---

## Phase 2 — Performance baseline

### Backend memory — production (pre-Wave-6 code, 2 GB container limit)

Memory is reported per instance; the service restarted several times during the window.

| Instance | Window | Initial | Peak | Behaviour |
|---|---|---|---|---|
| `tccwh` | 20th 21:00 → 21st 06:00 | 448 MB | 507 MB | flat ~448 MB for 7 h, then monotonic climb |
| `zzt7d` | 07:00 → 10:00 | 424 MB | 533 MB | monotonic climb, no recovery, then replaced |
| `w24jz` (current) | 13:30 → 21:00 | 336 MB | 421 MB | oscillates and **recovers** to 322–352 MB |

The two earlier instances show the pattern Wave 6 set out to address: memory rising under
load and never returning. The current instance reclaims memory and settles below its
starting point. That is encouraging but **not attributable to Wave 6**, which is not
deployed; the current instance also served far less traffic after 14:00. Treat the
`w24jz` curve as inconclusive rather than as evidence of a fix.

- Peak observed RSS: **533 MB** against a 2 GB limit — ample headroom, no OOM risk.
- CPU: 0.002–0.035 cores. The service is nowhere near CPU bound.

Stable RAM after 1 hour under controlled load: **NOT CERTIFIED** (no load generator was
run against production).

### Backend memory — local, post-Wave-6 build

Measured from `/api/health/metrics` on a locally booted production build:

| Metric | Value |
|---|---|
| RSS | 251 MB |
| Heap used | 115 MB |
| Heap total | 118 MB |
| External | 24 MB |
| ArrayBuffers | 5 MB |
| Event-loop utilisation | 2.14 % |
| Event-loop p99 | 27.03 ms |

Idle, single process, empty database — a floor measurement, not a load figure.

### API performance — production

`www.hmdinternationalgroup.com` is the host carrying real ERP traffic (2 000–6 300
successful requests per 30 min at peak). `erp-pos-system-copy.onrender.com` is
effectively idle (0–2 requests per 30 min) and should not be used to judge performance.

p95 response time by status, 10:00–14:00:

| Status | p95 |
|---|---|
| 200 | 47–149 ms |
| 201 | 15–17 ms |
| 204 | 20–40 ms |
| 304 | 41–184 ms |
| 401 | 4–7 ms |
| 404 | 7–75 ms |

Error rate: 5xx responses are rare — single-digit counts per 30 min against thousands of
2xx, i.e. well under 0.1 %.

**Interpretation warning.** Render also reports a `statusCode: "0"` series with p95 values
of 439–2 707 *seconds*. These are long-lived SSE/event-stream connections
(`/api/screen-feed/live/status` and similar), which never complete with a status code.
They are expected open connections, **not** slow endpoints, and must not be read as an
API bottleneck.

Per-endpoint breakdown for Dashboard / Inventory / Factory / POS / Reports / Supplier
Partner / Chat, requests-per-minute, p50/p99, duplicate-call and refetch analysis:
**NOT CERTIFIED** — Render's HTTP metrics are not broken down per route at the
granularity required, and the in-app per-route telemetry is only populated by real
authenticated traffic.

---

## Phase 3 — Database certification

| Check | Result |
|---|---|
| No connection leaks | PASS |
| No unexpected slow queries | NOT CERTIFIED |

Active connections over 12 hours:

| Window | Connections |
|---|---|
| 09:00–13:00 (business hours) | 9 → 13 |
| 14:00–21:00 (idle) | 6 → 2–4 |

Connections rise with load and **return to a 2–4 baseline** when traffic stops. That is
the signature of a healthy pool with no leak, and it is the strongest single result in
this certification. Long-running transactions would have held the count high; none did.

- Database CPU: 0.008–0.034 cores.
- Database memory: 347–432 MB, flat, on a 1 GB plan.
- Application pool: `sessionPoolMax: 3`, pool warmed on first attempt.

Average query latency, slow-query enumeration, expensive joins, missing indexes and lock
waits are **NOT CERTIFIED**: that requires `pg_stat_statements` / `pg_locks` access against
the production database, which read-only metrics do not provide.

---

## Phase 4 — Bandwidth certification

| Check | Result |
|---|---|
| Pagination works | PASS |
| Caching works | PASS |
| Lazy loading works | PASS |
| No uncontrolled MB-sized requests | PASS (client shell) |

- **Pagination** is enforced at the bridge level: `defaultLimit 100`, `maxLimit 250`, over
  `/api/stock-items`, `/api/inventory`, `/api/factory/bales`, `/api/factory/daybook`,
  `/api/factory/v5/stock-allocation`, `/api/vouchers`, plus voucher-entry and account-
  transaction path patterns.
- **Caching** is demonstrably live in production: 304 responses run at roughly 250–700 per
  30 min against 2 000–6 300 200s, so conditional requests are being honoured at scale.
- **Lazy loading** holds. The four largest chunks are all route- or action-triggered and
  stay out of the initial shell:

| Chunk | Size |
|---|---|
| `fortune-sheet-vendor` | 2 646 KB |
| `ApplicationInterfaceTranslator` | 1 460 KB |
| `exceljs-vendor` | 908 KB |
| `xlsx-vendor` | 843 KB |
| `form-vendor` | 422 KB |

The initial load transfers **1 820 KB across 29 requests** — none of the multi-MB vendor
chunks among them. That is under control but is the natural next target if shell weight
is ever revisited.

Largest *API* JSON payloads and repeated-download analysis: **NOT CERTIFIED** — requires
authenticated traffic against seeded production-like data.

---

## Phase 5 — Frontend performance certification

Initial load of the ERP shell, local production build, cold cache, Chromium:

| Metric | Value |
|---|---|
| First Paint | 488 ms |
| First Contentful Paint | 564 ms |
| Largest Contentful Paint | 972 ms |
| DOMContentLoaded | 477 ms |
| Load event | 489 ms |
| Network settle (`networkidle2`) | 1 443 ms |
| Requests | 29 |
| Transferred | 1 820 KB |

Measured over loopback, so it excludes real network latency and is a best case. Bundle
composition is covered in Phase 4; no duplicated libraries were observed among the top
chunks, and the heavy vendors are correctly split.

Per-page certification of the ERP pages (Dashboard, Accounting, Inventory, Reports,
Customers, Suppliers), Factory pages (Containers, Offload, Production, Bale Stock,
Allocation, Transfers) and POS flows (Login, Item search, Sale, Edit sale, Printing,
WhatsApp): **NOT CERTIFIED** — every one of these is behind authentication and needs
seeded company/stock/voucher fixtures plus credentials, which this environment does not
have.

---

## Phase 6 — Realtime certification

**PASS** (second pass, 2026-09-22).

`scripts/run-wave6-realtime-browser-e2e.mjs` was run against a locally booted production
build with the repository's own disposable fixture. Both cases passed:

- two-session POS write auto-refreshes watched inventory (multi-user propagation);
- mobile inventory remains usable with the realtime stack enabled.

### Connect / disconnect memory cycles

The phase's exit condition — no memory growth across repeated connect/disconnect cycles —
was measured directly: **1 350 authenticated WebSocket connections** over nine cycles of
150 sockets each, opened, held, and closed, with heap sampled through the authenticated
`/api/health/metrics`.

| Measure | Baseline | After 1 350 connections + 30 s idle |
|---|---|---|
| Heap used | 127 MB | 138 MB |
| Heap total | 137 MB | 168 MB |
| External | 25 MB | 25 MB |
| RSS | 304 MB | 321 MB |

Heap used did not grow monotonically: it oscillated between 126 and 138 MB and dipped
**below** its own baseline mid-run, which only happens if per-socket state is being
collected. External memory — where socket buffers live — was **flat at 25 MB across all
1 350 socket lifecycles**, which is the strongest single indicator that the sockets, their
heartbeat timers, and the `socketCompanies` / `socketUsers` / `socketRemoteContexts` maps
are released on close.

Caveat: the residual +11 MB sits inside the observed oscillation band and reflects GC
timing, not accumulation. A forced-GC reading would settle it definitively, but `gc()`
cannot be triggered from outside the process.

## Phase 7 — Browser automation testing

**PASS** (second pass, 2026-09-22).

No new suite was written, deliberately: the repository already ships
`scripts/run-phase7-browser-e2e.mjs` with its fixture preparer. Writing a parallel suite
would duplicate that coverage and add surface this wave forbids. What was missing the
first time was not the tests but the fixture — `prepare-phase7-browser-e2e-fixture.mjs`
seeds its own users and refuses to run against anything but a local disposable
`heliumdb`, which this environment can now provide.

All **8 cases passed** against a locally booted production build:

| Case | Checklist flow covered |
|---|---|
| login and authenticated shell | Authentication → login |
| ERP POS sale updates inventory | POS → create sale; stock update |
| ERP stock transfer updates both locations | Factory → transfer |
| ERP journal voucher stays balanced | Accounting → create voucher, balance update |
| Factory offload and reverse round trip | Factory → offload |
| Supplier Partner sale preserves stock and accounting invariants | POS / accounting invariants |
| POS role is blocked from accounting and foreign companies | Company → permissions, isolation |
| English / French / Arabic runtime directions | i18n and RTL |

Not covered by this suite, and so still uncertified: logout, session expiration, explicit
company switching, bale creation, allocation, POS edit/print/WhatsApp, and voucher
edit/delete. They need either new cases or a manual pass.

## Phase 8 — Mobile certification

**NOT CERTIFIED.**

No physical iPhone or Android device, and no slow-network or offline-recovery harness, is
reachable from this environment. Emulation is not device certification and is not reported
as one.

The repository's emulated suite (`verify-mobile-responsive-wave4-browser.mjs`, six
viewports from `phone-320` to `desktop-1440`) was run against the seeded local build. It
does **not** pass here, but the failures do not establish a product defect:

- authentication and most factory routes render correctly at every viewport;
- the residual failures move between runs (`/factory/import` on all six viewports in one
  run, `/factory/stock-allocation-v5` at a single viewport in another), which is the
  signature of contention, not a broken layout;
- raising the per-step timeout from 45 s to 150 s did not clear them, but visiting the
  same routes directly in a fresh browser **does** render them — `/factory/import` in
  Factory mode reaches `#main-content` and shows its workspace.

The honest reading is that this container cannot run six viewports of heavy React pages
plus PostgreSQL plus the server without starving them. Mobile therefore stays NOT
CERTIFIED, and no mobile defect is claimed.

## Phase 9 — Production monitoring

**PASS, after Fix 2.**

The monitoring stack requested by this phase already exists from Phase 11 and earlier
waves; nothing new was built, which is correct under this wave's no-new-features rule:

- `GET /api/admin/operational-monitoring` (Admin/Owner, read-only) reports RAM, event
  loop, DB pool, API latency and error counts with named thresholds
  (`heap_usage`, `slow_request_rate`, `database_pool_waiting`, `http_server_error_rate`,
  `recent_critical_events`).
- `GET /api/health/performance` and `/api/health/incidents` serve a live dashboard and
  incident feed, with alert evaluation behind `OBSERVABILITY_ALERTS_ENABLED`.
- `GET /api/health/metrics` reports process, request, duration-bucket, bandwidth and pool
  telemetry.
- `server/runtimeObservability.mjs` logs a `runtime-pressure` warning when event-loop p99
  ≥ 250 ms or RSS ≥ 1 200 MB; `runtimeMemoryGuard` escalates and exits on sustained
  hard-limit breach.

A security defect in that surface was found and fixed — see Fix 2.

External alert *delivery* (paging on crash loops, DB failure, worker failure) is not wired
to any external provider; `docs/operations/external-alerting-checklist.md` is the existing
record of that gap. Unchanged by this wave.

---

## Fixes merged in this wave

Both are small, isolated, and adopt mechanisms the codebase already provides. Neither
changes business logic.

### Fix 1 — Insurance journal startup repair failed closed against RLS

**File:** `server/routes/factory/insuranceHistoricalRepairRoutes.ts`

Every production boot logged:

```
[ERROR] Automatic historical insurance journal direction repair failed.
        error=app.current_company_id is required for tenant data access
```

`autoRepairHistoricalInsuranceJournalDirections()` deliberately spans every company's
legacy `INS-*` vouchers, but it opened its transaction without declaring either scope that
`migrations/0016_company_scope_rls_readiness.sql` defines. `vouchers`, `voucher_entries`
and `ledger_accounts` are all `FORCE ROW LEVEL SECURITY`, so the policy raised and the
repair rolled back every time. The repair has therefore never run in production.

The migration documents exactly this case — "maintenance scope:
`app.company_scope_maintenance = 'on'` for controlled process-owned startup/scheduler
work" — and the sibling startup bridges (`workerBonusExpenseRepairBridge.mjs`,
`factoryChargeVoucherRepairBridge.mjs`, `stockItemSchemaRepairBridge.mjs`) already use it.
The repair now opts into the same scope inside its existing transaction.

Verified against a local database with RLS installed and a non-superuser role:

- without the scope, `erp_company_scope_matches(1)` raises the exact production error;
- with it, the call returns true and the repair proceeds;
- the settings are transaction-local — after `COMMIT` and after `ROLLBACK` the value reads
  `<unset>` and RLS fails closed again, so a pooled connection cannot inherit maintenance
  scope. This was checked explicitly because a leak would be an RLS bypass.

### Fix 2 — `/api/health/metrics` served internal telemetry without authentication

**Files:** `server/runtimeObservability.mjs`, `server/middleware/requestLogger.ts`

`runtimeObservability.mjs` patches `Server.prototype.emit` and answered
`/api/health/metrics` directly — before Express, before sessions, with no authorisation —
returning uptime, RSS/heap/external/arrayBuffer memory, request and 5xx counts,
event-loop statistics and export-coordinator queue depth.

That hook shadowed the Express route in `requestLogger.ts`, which does enforce
Admin/Developer and returns 403 otherwise, making that gate unreachable dead code. The
documented contract is unambiguous and stated in three places —
`docs/monitoring/health-metrics.md` ("limited to authenticated `Admin` and `Developer`
sessions"), `docs/operations/external-alerting-checklist.md` ("Protected internal metrics
endpoint"), `docs/archive/logging-phase-10-release.md`.

The module is loaded in production (`npm start` → `runtimeMemoryGuard.mjs` →
`runtimeObservability.mjs`, confirmed by the `Runtime observability started` line in the
production log), so the exposure was live. Direct confirmation against the production URL
was not possible: egress to that host is blocked by this environment's network policy.

The pre-Express interception was removed so the request falls through to the authenticated
route. To avoid losing operator visibility, the module now publishes its snapshot on
`globalThis.__erpRuntimeObservabilitySnapshot`, and the authenticated handler merges it
into its response under `runtime`. The merge is done at the route, not inside
`getRequestMetricsSnapshot()`, so the `/api/admin/operational-monitoring` response
contract is untouched.

Verified locally on the production build: `/api/health/metrics` now returns
`403 {"message":"Admin or Developer access required."}` unauthenticated, while
`/api/health`, `/api/health/ready`, `/api/health/live` and `/api/health/db` still return
200 so liveness and readiness probes are unaffected.

---

## Second pass — 2026-09-22

Four checks were **already red on `main`** before this wave began. Each was confirmed
pre-existing by stashing every Wave 7 change and re-running, then fixed.

### Fix 3 — Startup migration 005 aborted on any database with drifted archive tables

`server/startup-schema/005-orphan-fk-repairs.ts` creates each orphan-archive table with
`CREATE TABLE IF NOT EXISTS _orphan_archive_<t> AS TABLE <t>`, which freezes the source's
column list on the first run. Later migrations and the runtime schema bridges keep adding
columns to the source, so on a later boot the archive is narrower than the source and the
positional `SELECT r.*, now(), reason` insert fails:

```
INSERT has more expressions than target columns
```

Reproduced exactly: a first boot succeeds, the multilingual bridge then adds
`customer_order_bale_removals.product_name_fr`, and the second boot reports
`1 migration(s) failed`. The archive had 13 columns against a source of 12 + 2.

The copy now runs in a `DO` block that first adds any column the source has gained to the
archive, then inserts **by explicit column name**. Naming the columns is what makes the
backfill safe: appended columns land at the end of the archive's column order, so
positional insertion could not have survived it.

Verified functionally, not just by exit code — a deliberate orphan row was archived with
every column aligned (`product_name_fr` = "Wave7 Product FR" landing in `product_name_fr`,
not in `archived_at`), `archive_reason` set, and the row removed from the source. Two
consecutive boots then reported `failureCount: 0`.

Production is unaffected today because it runs `RUN_STARTUP_MIGRATIONS=false`, but every
environment that does run them — CI's schema step, the documented fresh-database
bootstrap, developer machines — hits this on its second boot.

### Fix 4 — `npm run test:smoke-sweep` was failing

This is the API smoke sweep in `main-certification.yml`, so `main`'s own certification
workflow was red. Two independent causes:

1. Wave 5 added `blanketInvalidations`, `targetedInvalidations` and `invalidatedEntries`
   to `readMicrocache` and the baseline was never regenerated.
2. `/api/stats/group-net-position-excel` — a workbook endpoint added during these waves —
   was being shape-pinned at all. Its body parses into thousands of byte-offset keys that
   shift whenever the zip container's timestamps change, so it could never stabilise. It
   now joins the two workbook endpoints already listed as `unstable`.

The baseline was regenerated on a **CI-equivalent disposable database** (`postgres` →
`drizzle-kit push` → one server boot → sweep), which matters: an earlier regeneration
against a reused scratch database also collapsed `/api/chat/users` to `[]` and was backed
out rather than committed. The committed regeneration also adds 21 endpoints introduced
across Waves 1–6 that the stale baseline never covered, taking the sweep from ~425 to 446
pinned routes. Green and byte-identical across consecutive runs.

### Fix 5 — `npm run verify:env-docs` was failing

Wave 6 introduced ten memory-bounding environment variables and documented none of them,
failing the documentation gate in `ci.yml`. All ten are now in `.env.example` with their
defaults, their ignored-value floors, and why each bound exists:
`SIMPLE_CACHE_MAX_ENTRIES`, `ERP_CONTEXT_CACHE_MAX_ENTRIES`, `EXPORT_JOB_MAX_ENTRIES`,
`EXPORT_JOB_MAX_STEPS`, `POS_TEMP_FILE_MAX_ENTRIES`, `POS_TEMP_FILE_MAX_BYTES`,
`GIT_IMPORT_UNDO_MAX_ENTRIES`, `TRACKING_RATE_LIMIT_MAX_ENTRIES`,
`PUPPETEER_BROWSER_IDLE_MS`, `PUPPETEER_PREWARM`. The gate now reports 151 variables
documented across four deployment examples.

### Fix 6 — `npm run audit:scripts` was failing through the i18n audit

The 2-bale Stock Entry limit shipped with thirteen untranslated literals in
`StockEntryTab.tsx`, taking the factory module from 0 actionable literals to 13 and the
total from 36 to 40. The five distinct strings are now translated into English, Arabic and
French in `client/src/i18n/factoryStockEntryTranslations.ts` and resolved through
`ApplicationInterfaceTranslator` like every other factory surface — the same runtime
mechanism the rest of the application uses, not a suppression. Factory is back to 0 and
the total is 27 against a baseline of 36.

### Fix 7 — `render.yaml` described a smaller deployment than the one running

It declared the `starter` plan, a `basic-256mb` database and a 384/448 MB memory guard.
The live service is `standard` with a `basic_1gb` PostgreSQL 18 database and a 1200/1500
guard, so **applying the manifest would have downgraded production**. Sizing, region,
database name and session-pool budget now match the service as read from the Render API;
values that cannot be read back through the API are marked as such in the file.

`scripts/verify-program6f-export-resource-controls.mjs` pinned the same stale 512 MB
Starter numbers and failed against the corrected manifest. Its four memory assertions were
moved to the real ceiling; the guard's intent — cap the JS heap below the container,
start shedding pressure before the container OOMs — is unchanged.

---

## Findings raised but deliberately not fixed

1. **Production is 68 commits behind `main`** (Phase 1). Fixing this means deploying to a
   live system, which was explicitly out of scope for this read-only certification. It is
   the one remaining blocking item.
2. **No external alert delivery** (Phase 9) — `docs/operations/external-alerting-checklist.md`
   is the existing record of that gap; unchanged by this wave.
3. **The emulated mobile suite does not pass in this container** (Phase 8). Not
   attributed to a product defect; see that phase for why.

## Verification performed on the certified tree

| Check | Result |
|---|---|
| `npm run check` (TypeScript) | PASS |
| `npm run build` | PASS — vite 8.3.0, 5 785 modules |
| `npm run lint` | PASS |
| Prettier on every changed file | PASS |
| `npm run test:frontend` | PASS — 175 files, 1 193 tests |
| `npm run test:smoke-sweep` | PASS — green and stable across consecutive runs |
| `npm run verify:env-docs` | PASS — 151 variables documented |
| `npm run audit:scripts` (incl. i18n audit) | PASS |
| `npm run audit:doc-index` / `type-escapes` / `write-routes` / `write-evidence` / `toolchain` / `lint-ratchet` | PASS |
| `verify:lockfile` / `verify:migrations` / `verify:production-dependencies` / `verify:final-production-readiness` | PASS |
| `verify-program6f-export-resource-controls` / `verify-readable-logging-phase-10` | PASS |
| i18n contract suite | PASS — 13 tests |
| requestLogger + performanceDashboard + phase 11 + insurance suites | PASS — 36 tests |
| Phase 7 browser E2E | PASS — 8/8 cases |
| Wave 6 realtime browser E2E | PASS — 2/2 cases |
| Startup migrations on a disposable database | PASS — `failureCount: 0`, two consecutive boots |
| Local production boot | PASS — 0 startup errors |
| Health endpoint authorisation | PASS — 200/200/403/403 |

---

## Final certification

```
ERP + FACTORY SYSTEM
Wave 7 Production Certification

Deployment:      FAIL          production is 68 commits behind main
Backend:         PASS          local build; production still pre-Wave-6
Database:        PASS          no connection leak; query profiling not certified
Frontend:        PARTIAL       initial load certified; per-page not certified
Realtime:        PASS          1,350 connect/disconnect cycles, no accumulation
Browser Tests:   PASS          8/8 flows against a real browser
Mobile:          NOT CERTIFIED no physical devices

Performance comparison
                      Before (prod, pre-Wave-6)    After (local, Wave 6 merged)
RAM                   424-533 MB climbing          251 MB RSS / 115 MB heap idle
API latency (p95)     47-149 ms                    not comparable (no load)
DB latency            not measurable               not measurable
Bandwidth (shell)     not measured                 1,820 KB / 29 requests
Frontend load         not measured                 FCP 564 ms / LCP 972 ms
Error rate            < 0.1 % 5xx                  0 errors at startup

Final Result: REQUIRES FIXES
```

Seven defects were found and fixed across the two passes: two in the first
(the insurance repair failing closed against RLS, and `/api/health/metrics` served
without authentication) and five in the second (the startup-migration archive drift and
four checks that were already red on `main`). Every one is merged on the certification
branch with its verification recorded above.

The wave does not reach CERTIFIED for one reason only: **production does not run the
certified code**, so Waves 1–6 remain unverified in production and every production
number in this report describes a pre-Wave-6 build. Mobile is a secondary gap that needs
hardware this environment does not have.

### To reach CERTIFIED

1. Merge this branch and deploy `main` to `srv-d6kibgtactks739u7vl0`. The service has
   `autoDeploy: no`, so this is a manual action.
2. Confirm on the new release that the insurance repair error is gone from the boot log
   and that `/api/health/metrics` returns 403 unauthenticated.
3. Re-read production memory over a full business day on the Wave 6 build and compare
   against the 424–533 MB climbing baseline recorded here. That comparison is the real
   before/after this wave was asked for, and it cannot be produced until step 1 happens.
4. Run the mobile suites on real iPhone and Android hardware.
5. Extend the Phase 7 suite to the flows it does not yet cover: logout, session
   expiration, company switching, bale creation, allocation, POS edit/print/WhatsApp, and
   voucher edit/delete.
