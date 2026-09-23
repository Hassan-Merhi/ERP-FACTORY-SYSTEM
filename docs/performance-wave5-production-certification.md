# Wave 5 — Production Performance Certification

Wave 5 closes the performance program after the four implementation waves were merged:

- PR #1599 — hidden-tab and request-churn cleanup.
- PR #1600 — frontend/browser startup and chunking work.
- PR #1601 — API payload and bandwidth reduction.
- PR #1608 — production-proven database hotspot optimization.

The remaining work is production measurement, not another speculative optimization pass.

## What the certification does

`npm run certify:performance-wave5` launches a headless authenticated browser against the deployed application, measures the configured read-only route twice, verifies `/api/health/ready` and `/api/health/db`, and reads the protected `/api/health/performance.json` dashboard.

The command is intentionally **not** run automatically from pull-request or main CI. It requires a deployed build, production traffic, and an Admin or Developer test account. CI only runs the lightweight static contract verifier so the production measurement path cannot silently disappear or become write-capable.

The certification is read-only from the application point of view. It navigates pages and performs GET requests only. Do not point it at a route whose initial render performs an approved business mutation.

## Required environment

```bash
ERP_PERF_CERT_BASE_URL=https://your-production-host
ERP_PERF_CERT_USERNAME=<non-production-admin-or-developer>
ERP_PERF_CERT_PASSWORD=<password>
npm run certify:performance-wave5
```

Optional settings:

- `ERP_PERF_CERT_ROUTES` — comma-separated routes; defaults to `/financial-overview`.
- `ERP_PERF_CERT_MIN_TOTAL_SAMPLES` — minimum requests required in the live dashboard window; default 10.
- `ERP_PERF_CERT_MIN_ROUTE_SAMPLES` — minimum samples before a server-reported route budget breach blocks certification; default 3.
- `ERP_PERF_CERT_MAX_ERROR_PERCENT` — maximum 5xx percentage in the dashboard window; default 1.
- `ERP_PERF_CERT_MAX_RSS_MB` — optional deployment-specific RSS ceiling.
- `ERP_PERF_CERT_MAX_OVERALL_P95_MS` — optional deployment-specific overall p95 ceiling.
- `ERP_PERF_CERT_OUTPUT_DIR` — output location; defaults to `artifacts/performance-wave5`.

The existing server budgets remain authoritative: normal routes use the dashboard's 500 ms latency / 300 ms DB / 20-query budgets, while heavy routes use the dashboard's 1,000 ms / 700 ms / 40-query budgets. Wave 5 does not create a conflicting second set of route thresholds.

## Pass criteria

A production certification passes when:

1. the configured authenticated route loads successfully on the first and repeat pass;
2. readiness and database health endpoints return success;
3. the protected performance snapshot is accessible with the test account;
4. the live window has enough samples to be meaningful;
5. the live 5xx percentage remains within the configured ceiling;
6. no route with enough samples is listed by the server as breaching its existing performance budget; and
7. the browser run records no document/script/stylesheet load failures or page errors.

A waiting database connection is recorded as a warning because a single snapshot can catch a transient waiter. Deployment-specific hard RSS or overall-p95 ceilings are available through environment variables when the Render plan has an agreed resource target.

## Evidence

The command writes:

- `artifacts/performance-wave5/report.json` — full machine-readable evidence.
- `artifacts/performance-wave5/summary.md` — compact human-readable result.

Keep production credentials out of the repository and artifacts. The report contains route names and aggregate measurements, not the supplied username/password.

If the certification fails, optimize only the routes named by the live evidence, then rerun the same command after deployment. Do not add indexes, polling, caching, or payload changes from static guesses alone.
