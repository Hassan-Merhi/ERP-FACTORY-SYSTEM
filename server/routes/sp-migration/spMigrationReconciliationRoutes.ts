/**
 * SP migration routes - Final reconciliation report and the hard guard blocking the unimplemented cutover.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import { pn } from "./_helpers";

export function registerSpMigrationReconciliationRoutes(app: Express) {
  // ── Final reconciliation report ─────────────────────────────────────────
  // GET /api/sp/migration/gc-reconciliation
  app.get(
    "/api/sp/migration/gc-reconciliation",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const sourceId = parseInt(String(req.query.sourceCompanyId ?? ""), 10);
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!sourceId || !targetId)
          return res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });

        const areas: Array<{ area: string; status: "PASS" | "FAIL" | "WARN"; detail: string; mismatches?: string[] }> =
          [];

        // 1. Stock master: every source stock item (with positive inventory) must have a target link
        const unlinkedItemRows = (
          await db.execute(sql`
          SELECT si.id, si.code, si.name FROM stock_items si
          JOIN inventory inv ON inv.stock_item_id = si.id AND inv.company_id = ${sourceId}
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL AND inv.quantity > 0
            AND NOT EXISTS (
              SELECT 1 FROM sp_migration_source_links l
              WHERE l.source_table = 'stock_items' AND l.source_id = si.id AND l.target_table = 'stock_items'
            )
          ORDER BY si.code LIMIT 50
        `)
        ).rows;
        areas.push({
          area: "Stock master",
          status: unlinkedItemRows.length === 0 ? "PASS" : "FAIL",
          detail:
            unlinkedItemRows.length === 0
              ? "All source stock items are linked to target."
              : `${unlinkedItemRows.length} source item(s) have no target stock item link (showing up to 50).`,
          mismatches: unlinkedItemRows.map((r) => `${r.code} — ${r.name}`),
        });

        // 2. Stock in hand: per-item qty comparison via source links (source vs mapped target item),
        // not just a global sum, so items that offset each other don't hide real mismatches.
        const perItemStock = (
          await db.execute(sql`
          SELECT si.code, si.name,
                 COALESCE((SELECT SUM(quantity) FROM inventory WHERE company_id = ${sourceId} AND stock_item_id = si.id), 0) AS src_qty,
                 COALESCE((SELECT SUM(quantity) FROM inventory WHERE company_id = ${targetId} AND stock_item_id = l.target_id), 0) AS tgt_qty
          FROM stock_items si
          JOIN sp_migration_source_links l ON l.source_table = 'stock_items' AND l.source_id = si.id AND l.target_table = 'stock_items'
          WHERE si.company_id = ${sourceId} AND si.deleted_at IS NULL
        `)
        ).rows;
        const stockMismatches = perItemStock.filter((r) => Math.abs(pn(r.src_qty) - pn(r.tgt_qty)) > 0.01);
        // Value by the stored total_value (wave 11): quantity × average_rate drifts.
        const srcStock = (
          await db.execute(
            sql`SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(total_value),0) AS v FROM inventory WHERE company_id = ${sourceId}`
          )
        ).rows[0];
        const tgtStock = (
          await db.execute(
            sql`SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(total_value),0) AS v FROM inventory WHERE company_id = ${targetId}`
          )
        ).rows[0];
        areas.push({
          area: "Stock in hand",
          status: stockMismatches.length === 0 ? "PASS" : "WARN",
          detail: `Totals — source qty ${pn(srcStock.q).toFixed(3)} vs target qty ${pn(tgtStock.q).toFixed(3)} (value ${pn(srcStock.v).toFixed(2)} vs ${pn(tgtStock.v).toFixed(2)}). ${stockMismatches.length} linked item(s) have a qty mismatch.`,
          mismatches: stockMismatches
            .slice(0, 50)
            .map((r) => `${r.code} — source ${pn(r.src_qty).toFixed(3)} vs target ${pn(r.tgt_qty).toFixed(3)}`),
        });

        // 3. Historical sales — per-voucher check that each source sale has a migrated read-only copy
        const unmigratedSales = (
          await db.execute(sql`
          SELECT v.id, v.voucher_number FROM vouchers v
          WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales','Sale') AND v.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sp_migration_source_links l
              WHERE l.source_table = 'vouchers' AND l.source_id = v.id AND l.target_table = 'vouchers'
            )
          ORDER BY v.voucher_number LIMIT 50
        `)
        ).rows;
        const srcSales = (
          await db.execute(
            sql`SELECT COUNT(*) AS cnt FROM vouchers WHERE company_id = ${sourceId} AND voucher_type IN ('Sales','Sale') AND deleted_at IS NULL`
          )
        ).rows[0];
        const tgtSales = (
          await db.execute(
            sql`SELECT COUNT(*) AS cnt FROM vouchers WHERE company_id = ${targetId} AND source_module = 'SP_MIGRATION_READONLY' AND deleted_at IS NULL`
          )
        ).rows[0];
        const srcSaleItems = (
          await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM sales_items si JOIN vouchers v ON v.id = si.voucher_id
          WHERE v.company_id = ${sourceId} AND v.voucher_type IN ('Sales','Sale') AND v.deleted_at IS NULL
        `)
        ).rows[0];
        const migratedSaleItems = (
          await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM sales_items si JOIN vouchers v ON v.id = si.voucher_id
          WHERE v.company_id = ${targetId} AND v.source_module = 'SP_MIGRATION_READONLY' AND v.deleted_at IS NULL
        `)
        ).rows[0];
        const migratedVouchersWithoutItems = (
          await db.execute(sql`
          SELECT v.voucher_number FROM vouchers v
          WHERE v.company_id = ${targetId} AND v.source_module = 'SP_MIGRATION_READONLY' AND v.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM sales_items si WHERE si.voucher_id = v.id)
          ORDER BY v.voucher_number LIMIT 50
        `)
        ).rows;
        const salesStatus =
          unmigratedSales.length > 0 ? "WARN" : migratedVouchersWithoutItems.length > 0 ? "WARN" : "PASS";
        areas.push({
          area: "Historical sales",
          status: salesStatus,
          detail:
            `Source: ${pn(srcSales.cnt)} sale voucher(s), ${pn(srcSaleItems.cnt)} item row(s). ` +
            `Migrated read-only: ${pn(tgtSales.cnt)} voucher(s), ${pn(migratedSaleItems.cnt)} item row(s). ` +
            `${unmigratedSales.length} source sale(s) have no migrated copy. ` +
            `${migratedVouchersWithoutItems.length} migrated voucher(s) have no item rows (accounting-only).`,
          mismatches: [
            ...unmigratedSales.map((r) => `Not migrated: ${r.voucher_number}`),
            ...migratedVouchersWithoutItems.map((r) => `No item rows: ${r.voucher_number}`),
          ],
        });

        // 4. Containers — list which source containers have no migrated sp_containers row
        const unmigratedContainers = (
          await db.execute(sql`
          SELECT c.id, c.container_number, c.status FROM containers c
          WHERE c.company_id = ${sourceId}
            AND NOT EXISTS (
              SELECT 1 FROM sp_migration_source_links l
              WHERE l.source_table = 'containers' AND l.source_id = c.id AND l.target_table = 'sp_containers'
            )
          ORDER BY c.container_number LIMIT 50
        `)
        ).rows;
        const srcContainers = (
          await db.execute(sql`SELECT COUNT(*) AS cnt FROM containers WHERE company_id = ${sourceId}`)
        ).rows[0];
        const tgtContainers = (
          await db.execute(sql`
          SELECT COUNT(*) AS cnt FROM sp_migration_source_links WHERE source_table = 'containers' AND target_table = 'sp_containers'
            AND run_id IN (SELECT id FROM sp_migration_rehearsal_runs WHERE source_company_id = ${sourceId} AND target_company_id = ${targetId})
        `)
        ).rows[0];
        areas.push({
          area: "Containers",
          status: unmigratedContainers.length === 0 ? "PASS" : "WARN",
          detail: `Source: ${pn(srcContainers.cnt)} container(s). Migrated: ${pn(tgtContainers.cnt)}. ${unmigratedContainers.length} container(s) not yet migrated (showing up to 50).`,
          mismatches: unmigratedContainers.map((r) => `${r.container_number} (${r.status})`),
        });

        // 4b. OTW containers must have a Goods-OTW accounting voucher posted
        const missingOtwVouchers = (
          await db.execute<{ container_number: string }>(sql`
          SELECT c.container_number FROM containers c
          WHERE c.company_id = ${sourceId} AND (c.status = 'OTW' OR c.status = 'Open')
            AND EXISTS (
              SELECT 1 FROM sp_migration_source_links l
              WHERE l.source_table = 'containers' AND l.source_id = c.id AND l.target_table = 'sp_containers'
                AND l.run_id IN (SELECT id FROM sp_migration_rehearsal_runs WHERE source_company_id = ${sourceId} AND target_company_id = ${targetId})
            )
            AND NOT EXISTS (
              SELECT 1 FROM vouchers v WHERE v.company_id = ${targetId} AND v.voucher_number = 'GC-OTW-' || ${targetId} || '-' || c.id
            )
          ORDER BY c.container_number LIMIT 50
        `)
        ).rows;
        areas.push({
          area: "Container OTW accounting",
          status: missingOtwVouchers.length === 0 ? "PASS" : "WARN",
          detail:
            missingOtwVouchers.length === 0
              ? "All migrated OTW containers have a Goods-OTW voucher posted."
              : `${missingOtwVouchers.length} migrated OTW container(s) are missing their Goods-OTW voucher.`,
          mismatches: missingOtwVouchers.map((r) => r.container_number),
        });

        // 5. Accounting balance — verify all migrated vouchers in target are balanced
        const unbalancedRows = (
          await db.execute(sql`
          SELECT v.voucher_number, SUM(ve.debit_amount::numeric) AS d, SUM(ve.credit_amount::numeric) AS c
          FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = ${targetId} AND (v.source_module IN ('ERP','SP_MIGRATION_READONLY','SP_MIGRATION'))
          GROUP BY v.id, v.voucher_number
          HAVING ABS(SUM(ve.debit_amount::numeric) - SUM(ve.credit_amount::numeric)) > 0.01
          LIMIT 50
        `)
        ).rows;
        areas.push({
          area: "Accounting",
          status: unbalancedRows.length === 0 ? "PASS" : "FAIL",
          detail:
            unbalancedRows.length === 0
              ? "All migrated vouchers are balanced."
              : `${unbalancedRows.length} migrated voucher(s) are unbalanced.`,
          mismatches: unbalancedRows.map(
            (r) => `${r.voucher_number} — Dr ${pn(r.d).toFixed(2)} vs Cr ${pn(r.c).toFixed(2)}`
          ),
        });

        // 6. Profit opening
        const profitOpening = (
          await db.execute(
            sql`SELECT voucher_number, total_amount FROM vouchers WHERE company_id = ${targetId} AND voucher_number LIKE 'GC-PROFIT-OPN-%'`
          )
        ).rows;
        areas.push({
          area: "Profit opening",
          status: profitOpening.length > 0 ? "PASS" : "WARN",
          detail:
            profitOpening.length > 0
              ? `${profitOpening.length} profit-opening voucher(s) posted.`
              : "No profit-share opening balance has been posted yet.",
          mismatches: profitOpening.map((r) => `${r.voucher_number} — ${pn(r.total_amount).toFixed(2)}`),
        });

        const overall = areas.some((a) => a.status === "FAIL")
          ? "FAIL"
          : areas.some((a) => a.status === "WARN")
            ? "WARN"
            : "PASS";

        // Detect the specific partial-run scenario: stock master done, stock-in-hand empty on
        // target, but later steps (historical sales / containers) already ran. Surface a clear
        // recovery instruction instead of silently letting the user proceed further.
        const stockMasterArea = areas.find((a) => a.area === "Stock master");
        const _stockInHandArea = areas.find((a) => a.area === "Stock in hand");
        const _salesArea = areas.find((a) => a.area === "Historical sales");
        const _containersArea = areas.find((a) => a.area === "Containers");
        const targetHasNoStock = pn(tgtStock.q) === 0 && pn(srcStock.q) > 0;
        const laterStepsRan = pn(tgtSales.cnt) > 0 || pn(tgtContainers.cnt) > 0;
        let partialMigrationWarning: string | null = null;
        if (stockMasterArea?.status === "PASS" && targetHasNoStock && laterStepsRan) {
          partialMigrationWarning =
            "This migration is partially applied. Stock opening failed but later steps were run. " +
            "Roll back Step 7 Containers, then Step 6 Historical Sales, then rerun Step 5 Stock Opening before continuing.";
        }

        return res.json({ overall, areas, partialMigrationWarning });
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-reconciliation error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── HARD GUARD: No cutover endpoint ─────────────────────────────────────
  // This explicitly blocks any attempt to POST to /api/sp/migration/cutover.
  // Phase 5 final migration is not implemented.
  app.all("/api/sp/migration/cutover", requireAuth, (_req: unknown, res: import("express").Response) => {
    return res.status(403).json({
      message: "BLOCKED: Final production migration (cutover) is not available. Phase 5 is disabled.",
      code: "CUTOVER_DISABLED",
    });
  });
}
