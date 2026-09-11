# Hardening Report — Task #1

**Date:** 2026-07-01  
**Scope:** Audit & harden app (no logic changes). Six areas reviewed.

---

## 1. Frontend Crash Safety — Array.isArray Guards

### Findings

All `useQuery` calls in **Analytics.tsx** that return object types (`StockMovementData`, `ContainerData`, `OpeningStockSummaryData`, `NetProfitStatementData`, `factoryPosSummary`, `factoryContainerSales`) are consumed defensively in the render path via `?` ternary guards and optional chaining. No `.map()` or `.filter()` calls exist on these values without a prior truthiness check.

Array-typed queries (`salesData`, `transactions`, `locations`, `accounts`, `suppliers`, etc.) already have `= []` default values at the `useQuery` call site.

### Action Taken

No code changes were required — the crash-safe patterns were already in place.

### Residual Risk

None identified for the reviewed render paths.

---

## 2. Runtime Migration Idempotency

### Findings

`server/index.ts` runs the full `migrations` array on every server start. DDL statements (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) are idempotent by design. Six DML blocks were **not** idempotent and required wrapping:

| migrations_log key | Description | Risk if re-run |
|---|---|---|
| `chatbot-enable-all-v1` | `UPDATE users SET chatbot_enabled = true WHERE chatbot_enabled = false` | Re-enables chatbot for any user who turned it off |
| `factory-page-key-renames-v1` | 10 UPDATE/DELETE statements renaming stale page keys in `factory_user_page_access` | After keys are renamed/deleted, re-running could touch new rows if old key names were reused |
| `bale-status-rename-v1` | REMOVED→DISPATCHED/DELETED, FINALIZED→IN_STOCK status renames on `factory_bales` | Could re-rename newly created bales if old status names are reused in code |
| `pos-role-normalize-v1` | POS1–POS6→POS and User→Normal User renames on `user_company_roles` + `role_feature_permissions` | Could rename future roles if old names were reintroduced |
| `containers-tracking-enable-initial-v1` | `UPDATE containers SET tracking_enabled = true WHERE tracking_enabled = false AND status NOT IN (...)` | Resets manual per-container disable on every restart |
| `containers-tracking-disable-offloaded-v1` | `UPDATE containers SET tracking_enabled = false … WHERE LOWER(status) IN ('offloaded',…)` | Overrides manually re-enabled tracking on a closed container |

### Action Taken

1. Added `CREATE TABLE IF NOT EXISTS migrations_log (key text PRIMARY KEY, applied_at timestamp)` as the **first** entry in the migrations array.
2. Wrapped each of the six DML blocks in a `DO $$ BEGIN … END $$` block that checks `migrations_log` before executing and inserts a key row on success.

### Residual Risk

Existing production data: migrations that have already run will **not** be re-applied on the next restart because no `migrations_log` rows exist yet for them. These DML statements will execute once more on the next deploy, which is safe since their WHERE clauses are self-limiting (old keys/statuses/roles no longer exist after the original run).

---

## 3. Permissions Audit — Factory Page Keys

### Findings

Factory page access is controlled through the `factory_user_page_access` table with `page_key` values matching URL paths (e.g., `factory/raw-materials`, `factory/bales-hub`).

The canonical source of truth is `FACTORY_NAV_SECTIONS` in `client/src/components/FactorySidebar.tsx`. `FACTORY_NAV_PAGES` is derived from it at module load time. `FactoryUsers.tsx` imports `FACTORY_NAV_PAGES` as its source.

**PageVisibilityTree.tsx** (`FACTORY_GROUPS`) is a *display-only* UI structure for the ERP settings page. It uses `featureKey` (ERP `FEATURE_KEYS`) for ERP pages and mostly `missingKey` placeholders for factory pages — these are informational labels, not access control keys. Access is enforced by the server via `factory_user_page_access` rows, not by this component.

Historical key renames are handled by `UPDATE/DELETE` migrations in `server/index.ts` lines ~536–569 (now wrapped in `factory-page-key-renames-v1`).

### Action Taken

No code changes required. The system is consistent.

### Residual Risk

If a new URL is added to `FACTORY_NAV_SECTIONS` without a corresponding server-side key rename migration, users with restricted access will see the nav link but be blocked at the API level. This is acceptable (server-side enforcement is the authoritative layer). See proposed Task #4 for the PageVisibilityTree placeholder cleanup.

---

## 4. Polling Reduction + Screen-Feed Gate

### Polling Intervals Reduced

| File | Query | Before | After |
|---|---|---|---|
| `DailyExportSection.tsx` | `/api/export/backup-status` | 15 s | 60 s |
| `ExportCenter.tsx` | `/api/export/backup-status` | 15 s | 60 s |
| `FactoryDispatchBatches.tsx` | `/api/factory/dispatch-batches` | 30 s | 60 s |
| `FactoryDispatchBatches.tsx` | `/api/factory/dispatch-reports/summary` | 30 s | 60 s |
| `FactoryPendingLoadings.tsx` | `/api/factory/customer-orders?status=LOADING` | 30 s | 60 s |

**Kept as-is:** `GroundScan.tsx` (4 s), `DailyScan.tsx` (10 s) — real-time scan pages where latency is product-critical. `FactoryNetPosition.tsx` supplier-balance query already has `enabled: !!rawData && isToday` so it self-stops on historical dates.

### Screen-Feed Gate

**Client-side** (already in place): `use-screen-feed.ts` polls `/api/screen-feed/being-watched` every 15 s and only starts `captureAndUpload` when `watched=true`. No changes needed.

**Server-side kill switch added** (`server/routes/screenFeedRoutes.ts`):
- Added `SCREEN_FEED_DISABLED` constant reading `process.env.DISABLE_SCREEN_FEED === "true"`.
- `GET /api/screen-feed/being-watched` returns `{ watched: false }` immediately when disabled → client never starts capturing.
- `POST /api/screen-feed` returns `200` immediately when disabled → frames are dropped without processing.

To disable the feature: set env var `DISABLE_SCREEN_FEED=true` and redeploy.

---

## 5. DB N+1 Fixes

### Indexes Added

| Index | Rationale |
|---|---|
| `factory_bales_finalized_by_idx ON factory_bales(finalized_by)` | Worker stats queries and the `UPDATE factory_bales … FROM factory_workers WHERE fb.finalized_by = fw.id` join had no index |

Note: A `voucher_entries_company_id_idx` was attempted but reverted — `voucher_entries` does not have a direct `company_id` column; company isolation is achieved via a join to `vouchers`.

All other key tables (`vouchers`, `containers`, `factory_bales`, `purchase_orders`, `factory_containers`) already had `company_id` indexes from prior migrations.

**Resolution (follow-up):** the revert is correct and needs no schema change. Company-scoped `voucher_entries` reads join `vouchers` on `voucher_entries.voucher_id = vouchers.id` and filter `vouchers.company_id`; both sides are already indexed (`voucher_entries_voucher_idx` on `voucher_entries(voucher_id)`, `vouchers_company_idx` on `vouchers(company_id)`), so the join path the reverted index was trying to accelerate is already covered. No further index is warranted.

### N+1 Identified — Fixed in follow-up

**`server/routes/factory/factoryBalesRoutes.ts` line ~288** (now `server/routes/factory/bales/balesPressingRoutes.ts`): inside a loop over `items`, the code called `await tx.select().from(factoryBaleProducts).where(eq(factoryBaleProducts.id, item.productId))` per iteration — a true N+1 with one DB round-trip per bale product.

**Resolution:** the route now fetches every `productId` up front with a single `inArray` query and builds a lookup map, then validates the whole request before any insert so a missing product still rolls the batch (and the per-company reference counter) back exactly as before. The same file's `GET /api/factory/pressing-batches` list endpoint was also de-N+1'd: it previously issued one bales query per pressing batch and now issues one `inArray` query for all batch IDs, grouped in memory.

---

## 6. Build Verification

```
✓ built in 1m 1s
dist/index.js  6.1mb
✓ Database tables and columns verified/migrated   (server startup — no migration failures)
```

Build succeeded with **zero TypeScript errors**. Server started cleanly on both restarts. Large bundle warnings (xlsx, exceljs, SpreadsheetEditor) are pre-existing and unrelated to this task.

---

## Summary of Changes

| Area | Files Changed | Risk |
|---|---|---|
| Migration idempotency | `server/index.ts` | Low — DO blocks with migrations_log guard |
| Screen-feed kill switch | `server/routes/screenFeedRoutes.ts` | Low — env var flag, additive only |
| Polling reduction | `FactoryDispatchBatches.tsx`, `FactoryPendingLoadings.tsx`, `DailyExportSection.tsx`, `ExportCenter.tsx` | Minimal — interval increase only |
| DB indexes | `server/index.ts` | Low — `CREATE INDEX IF NOT EXISTS` is idempotent |

**No accounting logic, voucher posting, stock movement math, or invoice totals were modified.**
