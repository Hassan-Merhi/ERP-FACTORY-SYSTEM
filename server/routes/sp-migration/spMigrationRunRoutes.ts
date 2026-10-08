/**
 * SP migration routes - Migration preview, run history, rehearsal and rollback.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { inventoryCutoverRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { requireAuth, requireRole } from "../../auth";
import {
  privilegedConcurrencyLimit,
  privilegedDestructiveRateLimit,
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import { sql } from "drizzle-orm";
import { pn, buildGcMigrationPreview } from "./_helpers";

const spMigrationReadConcurrency = privilegedConcurrencyLimit({
  scope: "sp-migration-read",
  maxConcurrent: 2,
});
const spMigrationRollbackConcurrency = privilegedConcurrencyLimit({ scope: "sp-migration-rollback" });
const spMigrationRollbackBudget = privilegedRequestBudget({ maxBodyBytes: 64 * 1024, maxCollectionItems: 100 });

export function registerSpMigrationRunRoutes(app: Express) {
  // ── GET /api/sp/migration/preview ────────────────────────────────────────
  // Legacy alias — kept only for backward compatibility. Returns the exact same
  // shape as /gc-preview (see buildGcMigrationPreview) so no two preview
  // endpoints ever disagree on field names again.
  app.get(
    "/api/sp/migration/preview",
    requireAuth,
    requireRole("Developer"),
    privilegedReadRateLimit,
    spMigrationReadConcurrency,
    async (req: Request, res: Response) => {
      try {
        const sourceId = parseInt(String(req.query.sourceCompanyId ?? ""), 10);
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!sourceId || !targetId) {
          return res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });
        }
        if (sourceId === targetId) {
          return res.status(400).json({ message: "Source and target companies must be different" });
        }
        const { status, body } = await buildGcMigrationPreview(sourceId, targetId);
        return res.status(status).json(body);
      } catch (err: unknown) {
        logger.error("[SP Migration] preview error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── GET /api/sp/migration/runs ──────────────────────────────────────────
  app.get(
    "/api/sp/migration/runs",
    requireAuth,
    requireRole("Developer"),
    privilegedReadRateLimit,
    async (_req: unknown, res: import("express").Response) => {
      try {
        const runs = (
          await db.execute(sql`
        SELECT
          r.id, r.source_company_id, r.target_company_id,
          r.action, r.status, r.rows_created,
          r.created_at, r.completed_at, r.error_message, r.notes,
          sc.name AS source_name, tc.name AS target_name
        FROM sp_migration_rehearsal_runs r
        JOIN companies sc ON sc.id = r.source_company_id
        JOIN companies tc ON tc.id = r.target_company_id
        ORDER BY r.created_at DESC
        LIMIT 50
      `)
        ).rows;
        return res.json({ runs });
      } catch (_err: unknown) {
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/rehearsal ────────────────────────────────────
  // DISABLED: the old all-in-one rehearsal flow (default-warehouse + raw stock_item_id reuse +
  // source_type='opening_stock' + "recreate containers manually") is permanently retired.
  // Use the staged endpoints instead: gc-account-plan, gc-stock-master, gc-stock-opening,
  // gc-sales-readonly, gc-containers, gc-profit-opening, gc-reconciliation.
  app.post(
    "/api/sp/migration/rehearsal",
    requireAuth,
    requireRole("Developer"),
    privilegedMutationRateLimit,
    async (_req: unknown, res: import("express").Response) => {
      return res.status(410).json({
        message: "The old all-in-one GC migration flow is disabled. Use the staged migration steps instead.",
        code: "OLD_GC_REHEARSAL_DISABLED",
      });
    }
  );

  // ── POST /api/sp/migration/rollback ─────────────────────────────────────
  // Removes ONLY rows created by a specific rehearsal run.
  // Never touches source (ERP) company.
  app.post(
    "/api/sp/migration/rollback",
    requireAuth,
    requireRole("Developer"),
    privilegedDestructiveRateLimit,
    spMigrationRollbackBudget,
    spMigrationRollbackConcurrency,
    async (req: Request, res: Response) => {
      const { runId } = req.body ?? {};
      if (!runId) return res.status(400).json({ message: "runId is required" });

      try {
        // Fetch run metadata
        const runRow = (
          await db.execute(sql`
        SELECT id, source_company_id, target_company_id, status
        FROM sp_migration_rehearsal_runs WHERE id = ${runId} LIMIT 1
      `)
        ).rows[0];

        if (!runRow) return res.status(404).json({ message: "Run not found" });
        if (runRow.status === "rolled_back") {
          return res.status(400).json({ message: "This run has already been rolled back" });
        }
        if (runRow.status === "rollback") {
          return res.status(400).json({ message: "Rollback already in progress" });
        }

        const targetId = pn(runRow.target_company_id);
        const sourceId = pn(runRow.source_company_id);
        // Wave 11: deleting the run's stock rows is refused after the target's cut-over.
        const inventoryRefusal = await inventoryCutoverRefusal(db, targetId, "sp-migration-rollback");
        if (inventoryRefusal) return res.status(inventoryRefusal.status).json(inventoryRefusal.body);

        // Safety: never touch source company
        if (!targetId || targetId === sourceId) {
          return res.status(400).json({ message: "Rollback safety check failed: invalid target/source" });
        }

        // Fetch tracked rows
        const trackedRows = (
          await db.execute<{ table_name: string; row_id: number }>(sql`
        SELECT table_name, row_id FROM sp_migration_run_rows WHERE run_id = ${runId}
        ORDER BY id DESC
      `)
        ).rows;

        let deleted = 0;
        const byTable: Record<string, number[]> = {};
        for (const r of trackedRows) {
          if (!byTable[r.table_name]) byTable[r.table_name] = [];
          byTable[r.table_name].push(pn(r.row_id));
        }

        // Delete in safe order — children before parents, entries before vouchers before accounts
        const tableOrder = [
          "voucher_entries",
          "vouchers",
          "sp_container_lines",
          "sp_containers",
          "ledger_accounts",
          "inventory",
          "sp_stock_movements",
          "stock_item_code_aliases",
          "stock_items",
          "stock_groups",
          "stock_grades",
          "stock_categories",
          "locations",
        ];
        // All tracked deletions commit together so no voucher is left with a partial set of entries.
        await db.transaction(async (tx) => {
          for (const tbl of tableOrder) {
            const ids = byTable[tbl];
            if (!ids?.length) continue;
            for (const id of ids) {
              // Extra safety: verify the row belongs to target company before deleting
              let verified = false;
              if (tbl === "sp_stock_movements") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM sp_stock_movements WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "stock_item_code_aliases") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM stock_item_code_aliases WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "locations") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM locations WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "vouchers") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM vouchers WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "voucher_entries") {
                // voucher_entries has no company_id — verify via parent voucher
                const [chk] = (
                  await tx.execute<{ company_id: number }>(sql`
              SELECT v.company_id FROM voucher_entries ve
              JOIN vouchers v ON v.id = ve.voucher_id
              WHERE ve.id = ${id} LIMIT 1
            `)
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "ledger_accounts") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM ledger_accounts WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "inventory") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM inventory WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "stock_items") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM stock_items WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "stock_groups") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM stock_groups WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "stock_grades") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM stock_grades WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "stock_categories") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM stock_categories WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "sp_containers") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM sp_containers WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              } else if (tbl === "sp_container_lines") {
                const [chk] = (
                  await tx.execute<{ company_id: number }>(
                    sql`SELECT company_id FROM sp_container_lines WHERE id = ${id} LIMIT 1`
                  )
                ).rows;
                verified = !!chk && pn(chk.company_id) === targetId;
              }

              if (!verified) {
                logger.warn(`[SP Rollback] Skipped ${tbl} id=${id} — company_id mismatch or row not found`);
                continue;
              }

              if (tbl === "inventory") {
                await tx.execute(sql`DELETE FROM inventory WHERE id = ${id}`);
              } else if (tbl === "sp_stock_movements") {
                await tx.execute(sql`DELETE FROM sp_stock_movements WHERE id = ${id}`);
              } else if (tbl === "stock_item_code_aliases") {
                await tx.execute(sql`DELETE FROM stock_item_code_aliases WHERE id = ${id}`);
              } else if (tbl === "locations") {
                await tx.execute(sql`DELETE FROM locations WHERE id = ${id}`);
              } else if (tbl === "voucher_entries") {
                await tx.execute(sql`DELETE FROM voucher_entries WHERE id = ${id}`);
              } else if (tbl === "vouchers") {
                await tx.execute(sql`DELETE FROM vouchers WHERE id = ${id}`);
              } else if (tbl === "ledger_accounts") {
                await tx.execute(sql`DELETE FROM ledger_accounts WHERE id = ${id}`);
              } else if (tbl === "stock_items") {
                await tx.execute(sql`DELETE FROM stock_items WHERE id = ${id}`);
              } else if (tbl === "stock_groups") {
                await tx.execute(sql`DELETE FROM stock_groups WHERE id = ${id}`);
              } else if (tbl === "stock_grades") {
                await tx.execute(sql`DELETE FROM stock_grades WHERE id = ${id}`);
              } else if (tbl === "stock_categories") {
                await tx.execute(sql`DELETE FROM stock_categories WHERE id = ${id}`);
              } else if (tbl === "sp_container_lines") {
                await tx.execute(sql`DELETE FROM sp_container_lines WHERE id = ${id}`);
              } else if (tbl === "sp_containers") {
                await tx.execute(sql`DELETE FROM sp_containers WHERE id = ${id}`);
              }
              deleted++;
            }
          }
        });

        // Clean up provenance links written by this run (source-side rows are never touched)
        await db.execute(sql`DELETE FROM sp_migration_source_links WHERE run_id = ${runId}`);

        // Mark run as rolled_back
        await db.execute(sql`
        UPDATE sp_migration_rehearsal_runs
        SET status = 'rolled_back', completed_at = now(),
            notes = COALESCE(notes, '') || ' | ROLLED BACK'
        WHERE id = ${runId}
      `);

        return res.json({ success: true, runId, rowsDeleted: deleted });
      } catch (err: unknown) {
        logger.error("[SP Migration] rollback error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
