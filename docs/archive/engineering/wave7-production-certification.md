# Wave 7 — Production Certification & Final System Validation

Date: 2026-09-21
Repository HEAD certified: `6ecbd80` (`claude/wave-7-certification-n3op1s`, identical to `origin/main`)
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
- `render.yaml` has drifted from the live service and should not be read as describing
  production: it declares service `erp-pos-system` on the `starter` plan with a
  `basic-256mb` database, `MEMORY_SOFT_RSS_MB=384`, `PG_SESSION_POOL_MAX=2` and
  `healthCheckPath: /api/health/ready`. The live service is `system` on `standard` with a
  `basic_1gb` database, memory guard at `softRssMb 1200 / hardRssMb 1500`,
  `sessionPoolMax 3`, and no health check path configured. Not a runtime defect;
  reconciling it is recommended so the manifest is trustworthy.
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

**NOT CERTIFIED.**

The harness exists and is credible — `scripts/run-wave6-realtime-browser-e2e.mjs` drives
connect/reconnect/disconnect and multi-user cases through a real browser — but it
requires `ERP_E2E_USERNAME` / `ERP_E2E_PASSWORD`, POS credentials, and
`artifacts/phase7-browser-e2e/fixture.json`, none of which are available here.

What *was* confirmed: the runtime registers its realtime listeners once at boot
(`Read microcache invalidation listener ready`), and the screen-feed cleanup timer is
`unref`'d so it cannot hold the process open. The memory-growth-across-reconnect-cycles
exit condition is untested.

---

## Phase 7 — Browser automation testing

**NOT RUN.**

No new smoke suite was written, deliberately: the repository already has
`scripts/run-phase7-browser-e2e.mjs` with a fixture preparer
(`scripts/prepare-phase7-browser-e2e-fixture.mjs`), plus responsive and language browser
smokes. Writing a parallel suite would duplicate existing coverage and add surface, which
this wave explicitly forbids.

To run the required Authentication / Company / Factory / POS / Accounting flows, supply
credentials and a seeded database and invoke the existing scripts.

---

## Phase 8 — Mobile certification

**NOT CERTIFIED.** No physical iPhone or Android device, and no slow-network or
offline-recovery harness, is reachable from this environment. The repository's
`scripts/verify-mobile-responsive-wave*.mjs` suites cover emulated viewports and are the
right starting point, but emulation is not device certification and is not reported as
such here.

---

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

## Findings raised but deliberately not fixed

1. **Production is 68 commits behind `main`** (Phase 1). Fixing this means deploying, which
   was out of scope for this read-only certification. It is the blocking item.
2. **`npm run test:smoke-sweep` is red on `main`.** `/api/admin/operational-monitoring`
   drifted from `config/api-smoke-shapes.json` when Wave 5 added `blanketInvalidations`,
   `targetedInvalidations` and `invalidatedEntries` to `readMicrocache`; the baseline was
   never regenerated. Confirmed pre-existing by stashing all Wave 7 changes and re-running.
   The documented regeneration (`UPDATE_API_SMOKE_SHAPES=1`) was attempted and **backed
   out**: run against an empty scratch database it also collapsed `/api/chat/users` from a
   populated object shape to `[]` and introduced a new entry, which would have corrupted
   the baseline. This must be regenerated against a properly seeded database.
3. **`render.yaml` no longer describes the live service** (Phase 1 notes).
4. **No external alert delivery** (Phase 9).

---

## Verification performed on the certified tree

| Check | Result |
|---|---|
| `npm run check` (TypeScript) | PASS |
| `npm run build` | PASS — vite 8.3.0, 5 785 modules, 12.17 s |
| Prettier on changed files | PASS |
| `requestLogger` + `performanceDashboard` + phase 11 monitoring + insurance suites | PASS — 36/36 |
| `npm run test:smoke-sweep` | Unchanged from `main` (pre-existing failure, finding 2) |
| Local production boot | PASS — 0 startup errors |
| Health endpoint authorisation | PASS — 200/200/403/403 |

---

## Final certification

```
ERP + FACTORY SYSTEM
Wave 7 Production Certification

Deployment:      FAIL          production is 68 commits behind main
Backend:         PASS          local build; production pre-Wave-6
Database:        PASS          no connection leak; query profiling not certified
Frontend:        PARTIAL       initial load certified; per-page not certified
Realtime:        NOT CERTIFIED credentials and fixture unavailable
Browser Tests:   NOT RUN       existing harness needs credentials and fixture
Mobile:          NOT CERTIFIED no physical devices

Performance comparison
                      Before (prod, pre-Wave-6)    After (local, Wave 6 merged)
RAM                   424–533 MB climbing          251 MB RSS / 115 MB heap idle
API latency (p95)     47–149 ms                    not comparable (no load)
DB latency            not measurable               not measurable
Bandwidth (shell)     not measured                 1 820 KB / 29 requests
Frontend load         not measured                 FCP 564 ms / LCP 972 ms
Error rate            < 0.1 % 5xx                  0 errors at startup

Final Result: REQUIRES FIXES
```

The two defects found were fixed and merged. The wave does not reach CERTIFIED because
production does not run the certified code, so Waves 1–6 remain unverified in production,
and because the realtime, browser-flow and mobile exit conditions could not be exercised
from this environment.

### To reach CERTIFIED

1. Deploy `main` (`6ecbd80` or later, including both fixes) to `srv-d6kibgtactks739u7vl0`.
2. Confirm the insurance repair error no longer appears in the boot log and that
   `/api/health/metrics` returns 403 unauthenticated in production.
3. Re-read production memory over a full business day on the Wave 6 build and compare
   against the 424–533 MB climbing baseline recorded above.
4. Regenerate `config/api-smoke-shapes.json` against a seeded database and land it.
5. Run the existing realtime and Phase 7 browser suites with credentials and a fixture.
6. Run the mobile suites on real iPhone and Android hardware.
