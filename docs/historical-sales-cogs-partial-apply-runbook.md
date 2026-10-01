# Historical sales COGS: proven-rows-only partial apply runbook

The remaining blocked rows of the historical sales cost repair cannot be
proven from the evidence in the database (see
`historical-sales-cogs-transfer-revision-findings.md`). The full apply
(`HISTORICAL_SALES_COST_REPAIR_MODE=apply`) still requires a run with
status `ready` and zero blockers and is unchanged.

The partial apply is a separate, explicitly named path that writes **only**
rows whose `historical_sales_cost_repair_rows.status = 'ready'`.
Code: `server/services/inventory/historicalSalesCostPartialApply.ts`.

## What it writes

| Table | Apply | Rollback |
|---|---|---|
| `sales_items` (cost_price, total_cost, profit of target rows only) | exactly N updates | exactly N updates |
| `historical_sales_cost_repair_apply_log` (before/after snapshot) | exactly N inserts | exactly N updates (`rolled_back_at`) |
| `historical_sales_cost_repair_partial_applies` (one record per run) | 1 insert + 1 update | 1 update |
| anything else (inventory, stock movements, vouchers, journals, containers, valuation history, run rows) | 0 | 0 |

The transaction reads `pg_stat_xact_user_tables` at the start and end and
aborts unless the per-table write counts match that table exactly, so a write
to any other table (including through a trigger) is impossible to commit.
`historical_sales_cost_repair_rows` is never modified: blocked rows keep
status `blocked` and their blocker code and detail; unchanged rows stay
`unchanged`.

## Gates (all checked inside one SERIALIZABLE transaction, before any write)

1. Explicit run ID, the exact reviewed audit hash, the exact target hash, the
   mode flag `proven-rows-only`, and the confirmation
   `PARTIAL-APPLY-PROVEN-ROWS:<run>:<audit[0:12]>:<target[0:12]>`.
2. The run's algorithm version equals the running engine version.
3. Run status is `blocked` or `ready` and completed; no other partial apply is active.
4. Persisted row set equals the run totals (total, ready, blocked), ready rows
   are all `changed` with no blocker code, every blocked row has a code.
5. The target hash (sha256 over every ready row's id, company, voucher,
   location, item, original and proposed values) equals the approved hash.
6. Every company's V2 source-evidence hash recomputes to the reviewed value.
7. No canonical movement was back-dated and no historical voucher or container
   was edited after the run cutoff.
8. `sales_items` has no side-effect triggers.
9. Every target `sales_items` row exists, is locked `FOR UPDATE`, still has its
   voucher/company/item, and still equals the original cost_price, total_cost
   and profit. Every blocked and unchanged row still equals its original.
10. After the update: every target equals its proposed values, the live COGS
    and profit sums equal the proposed totals, blocked and unchanged rows still
    equal their originals, and the inventory fingerprint is unchanged.

A retry with the same approval is a no-op (`alreadyApplied: true`). A
rolled-back run cannot be re-applied; build a new dry-run instead.

While a partial apply is active, new dry-runs are refused
(`HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY`), because the engine reads
recorded sale costs as historical evidence. On startup this is logged and the
deploy continues; nothing is written.

## Running it (only after explicit approval)

Render environment, then deploy:

```
HISTORICAL_SALES_COST_REPAIR_MODE=partial-apply-proven-rows-only
HISTORICAL_SALES_COST_REPAIR_RUN_ID=<run>
HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH=<audit hash>
HISTORICAL_SALES_COST_REPAIR_TARGET_HASH=<target hash>
HISTORICAL_SALES_COST_REPAIR_PARTIAL_CONFIRMATION=PARTIAL-APPLY-PROVEN-ROWS:<run>:<audit[0:12]>:<target[0:12]>
```

Startup logs `HISTORICAL_SALES_COST_REPAIR_PARTIAL_PREVIEW`, then
`HISTORICAL_SALES_COST_REPAIR_PARTIAL_APPLY_RESULT` with the independent
verification. Any failure throws, the transaction rolls back, and Render
keeps the previous instance. Afterwards set the mode to `off`.

Or via `POST /api/admin/repair/historical-sales-cost/:runId/partial-apply`
(Developer role + password confirmation) with
`{ mode, auditHash, targetHash, confirmation }`.

Read-only endpoints: `GET .../:runId/partial-apply/preview` (`?ids=1` lists
target ids) and `GET .../:runId/partial-apply/verify`.

## Rollback

```
HISTORICAL_SALES_COST_REPAIR_MODE=partial-apply-rollback
HISTORICAL_SALES_COST_REPAIR_RUN_ID=<run>
HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH=<audit hash>
HISTORICAL_SALES_COST_REPAIR_ROLLBACK_CONFIRMATION=ROLLBACK-PARTIAL-APPLY:<run>:<audit[0:12]>
```

or `POST .../:runId/partial-apply/rollback` with `{ auditHash, confirmation }`.

Rollback restores every logged row to its exact before values from the
apply log. It fails closed (`HSCR_PARTIAL_ROLLBACK_ROWS_CHANGED_SINCE_APPLY`)
if any repaired row was changed after the apply, because restoring it would
overwrite that later change. It marks every log row `rolled_back_at`/`by`,
sets the record to `rolled_back` with a rollback report, and is idempotent.

## Independent verification SQL (read-only)

```sql
SELECT COUNT(*) AS rows,
       COUNT(*) FILTER (WHERE si.cost_price=l.after_cost_price AND si.total_cost=l.after_total_cost
                          AND si.profit=l.after_profit) AS at_proposed,
       SUM(l.before_total_cost) AS cogs_before, SUM(si.total_cost) AS cogs_live,
       SUM(l.before_profit) AS profit_before, SUM(si.profit) AS profit_live
  FROM historical_sales_cost_repair_apply_log l
  JOIN historical_sales_cost_repair_partial_applies p ON p.id=l.partial_apply_id
  LEFT JOIN sales_items si ON si.id=l.sales_item_id
 WHERE p.run_id=<run>;
```
