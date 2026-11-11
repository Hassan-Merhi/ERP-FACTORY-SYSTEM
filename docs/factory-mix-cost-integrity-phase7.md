# Factory Mix Cost Integrity — Phase 7: automatic monitoring and Factory Alerts

**Date:** 2026-11-09 (Asia/Beirut)  
**Branch:** `fix/factory-mix-cost-integrity-20261109` (Phases 1–7 on one branch).  
**Implementation:** Committed; not yet merged or deployed.  
**Live DB work this phase:** `SELECT` only; no historical fixes or vouchers.  
**CI/tests:** Regression tests added but not run, as previously requested.  
**Schema/SQL/TablePlus:** **None required**. Reuses the existing `factory_alerts` table.

## What runs automatically

A new, lightweight scheduler registration in `server/services/scheduler/index.ts` fires **daily 01:35 UTC**, with dynamic import only when due, within the existing `createSchedulerTick` process in-flight guard and application writer-fence policy. The source module `server/services/factory/mixPhase7IntegrityMonitor.ts` discovers all Factory company IDs with active mixes; it does **not** hardcode company #12.

The four existing read-only Phase 3–6 audits run per company, **sequentially** to avoid concurrent reporting load:

1. Historical stored source and batch arithmetic, missing material provenance and original USD.
2. Raw stock, recorded supplier ADD backing, owner-link evidence and old valued adjustment basis/FX.
3. Direct mix/bale/pressing/output provenance, linked finished-bale cost mismatches, sales and GL cutover status.
4. Used-vs-total kg, completed/closed remainder and carry-forward source/parent integrity.

Each audit has its own company-scoped `REPEATABLE READ READ ONLY` DB snapshot. They are independently sampled (not one global transaction). The monitor **never updates** a mix, supplier, raw-stock row, WIP, bale, invoice, journal or voucher. Only diagnostic state and alerts in `factory_alerts` are written.

### First successful run = historical baseline, not a false incident

Legacy company #12 already has known exceptions: 27 completed mixes with 128,193 recorded remaining kg, three overused mixes with 179 kg excess, ownership/adjustment reviews and missing historical cost-flow links. The first complete scan saves these **existing issues** as a durable baseline, so administrators are not flooded with notifications for old unchanged records. Those exceptions remain visible in the Phase 3–6 audit views.

The baseline is one `factory_alerts` row with `type='MIX_MONITOR_STATE'`, `entity_type='mix_monitor'`, `entity_id=0` and `is_read=true`; it holds a compact JSON set of issue keys, severity and optional numeric magnitude. The normal Factory Alerts page shows **only unread** alerts, so it does not show this hidden state.

Subsequent successful scans compare stable issue keys and create `MIX_INTEGRITY` alerts when:

- A previously absent error or evidence review appears.
- The same issue's **severity increases**.
- A known numeric discrepancy gets materially **worse**: overused kg, unused kg in completed mixes, raw-stock overdraw, stored source/header cost or weight math, or count of actually-linked bales with cost mismatch. Stored magnitudes use decimal arithmetic (kg threshold 0.001, USD threshold 0.02, exact count).

**Not an alarm:** today's supplier price changing since the historical mix, a supplier temporarily lacking a current locked rate, or the old lack of direct bale lineage alone. These remain visible in the read-only reports and block unsafe recosting where appropriate; they are not fabricated financial losses.

### Deduplication, recovery, and deployment safety

- A transaction-scoped PostgreSQL advisory lock on company ID serializes durable state and alerts **across Render workers/instances**, preventing duplicate notices when both scan simultaneously.
- A scan must successfully finish all four checks before advancing its baseline. On failure, the previous last-good state stays intact; a deduplicated `MIX_MONITOR_FAILURE` warning appears in Factory Alerts. Recovery automatically clears the unread failure warning.
- Previously unread alerts that have been *resolved in source data* are marked read for that exact issue key; unrelated Factory Alerts (e.g. missing container documents) are never touched.
- State parse/version corruption fails closed; it cannot silently reset the baseline or treat an incomplete scan as clean.
- Limits bound the number of findings and serialized state; there are no new SQL migrations or DDL at startup.
- Alert delivery is **inside ERP Factory Alerts** plus structured Render server logs, **not** WhatsApp, external push, email, or a ChatGPT automation.
- The daily task only starts when the deployment's main scheduler is running and the cloud writer policy permits background jobs. `ENABLE_SCHEDULERS=false` or `FACTORY_MIX_INTEGRITY_MONITOR_ENABLED=false` disables it. The monitor feature switch is enabled by default when allowed; the first scheduled check after deployment establishes the baseline.
- A missed check while the server is offline occurs on the **next scheduled day**. No immediate startup scan is forced, avoiding heavy production load on deployment.

## Factory Mode interface

The existing Mix Batch page contains a new **Phase 7 · Automatic Mix Integrity Monitoring** section for Admin/Owner/Developer only. It displays:

- Scheduler enabled/disabled and last successful check timestamp.
- Count of critical, warning and historical-evidence-review findings.
- Number of unread monitoring notifications.
- **Refresh Status** (a small GET that does NOT rerun heavy audit SQL).
- An explanation of baseline vs new issues and the no-auto-repricing safety rule.

The interface refreshes the small status every five minutes and isolates the company cache. The existing Factory Alerts page now consumes the actual `factory_alerts` response shape (`isRead`, `entityType`, `entityId`, severity `error` etc.) and polls every five minutes using a **company-scoped query key**, so users see the new monitoring alerts correctly.

The status uses the **existing** authenticated route:
```
GET /api/factory/mix-batches?profile=integrity-monitor
```
Access: Admin/Owner/Developer only, current company from session, private/no-store response. No new API path or manifest/migration change.

## Regression coverage

- `tests/factory-mix-phase7-integrity-monitor.test.ts`: recorded-price drift exclusion; error/warning/evidence classification; strict company isolation; first-run baseline; de-duplication; severity escalation; worsening numeric magnitude; resolution; unrelated-alert isolation; and transactional rollback after write failure.
- `tests/scheduler-entrypoint.test.ts`: fourth lazy nightly tick at 01:35 UTC and optional disable switch.
- Existing Phase 3–6 regressions remain on the branch.

The tests are committed **without executing the CI suite**, as requested during the phased implementation. Actual scheduling and alert delivery can only be verified once deployed; branch integration is not yet complete.

## Next step: Phase 8

Resolve 398+ commits of divergence from the live `main` branch, execute full tests and CI on the integrated code, validate Render deployment, then verify one scheduled baseline and a controlled new-issue test. Do not force-merge or deploy this branch without reconciliation. Existing historical accounting/quantity exceptions must remain intact until a separately approved evidence-based correction is possible.
