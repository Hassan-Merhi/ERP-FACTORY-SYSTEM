import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { ensurePhase2Schema, getSuspenseReview, pn } from "./spMigrationPhase2Common";
import { buildCutoverReadiness } from "./spMigrationCutoverReadiness";
import { ensureCutoverSchema, getLiveCutover } from "./spMigrationCutoverState";
import { firstRow } from "../../lib/queryResult";

export type VerificationStatus = "PASS" | "WARN" | "FAIL";
export type VerificationArea = {
  area: string;
  status: VerificationStatus;
  detail: string;
  mismatches: string[];
};

export function summarizeVerification(areas: VerificationArea[]): VerificationStatus {
  if (areas.some((area) => area.status === "FAIL")) return "FAIL";
  if (areas.some((area) => area.status === "WARN")) return "WARN";
  return "PASS";
}

async function companyRow(companyId: number): Promise<Record<string, unknown> | null> {
  const result = await db.execute(sql`
    SELECT id, code, name, company_type, active
    FROM companies
    WHERE id = ${companyId}
    LIMIT 1
  `);
  return firstRow(result) ?? null;
}

export async function buildFinalSpVerification(sourceId: number, targetId: number) {
  await Promise.all([ensurePhase2Schema(), ensureCutoverSchema()]);
  const areas: VerificationArea[] = [];
  const [source, target] = await Promise.all([companyRow(sourceId), companyRow(targetId)]);

  if (!source || !target) {
    return {
      overall: "FAIL" as VerificationStatus,
      sourceCompanyId: sourceId,
      targetCompanyId: targetId,
      generatedAt: new Date().toISOString(),
      areas: [
        { area: "Company pair", status: "FAIL", detail: "Source or target company does not exist.", mismatches: [] },
      ],
    };
  }

  areas.push({
    area: "Company types",
    status: source.company_type === "erp" && target.company_type === "supplier_partner" ? "PASS" : "FAIL",
    detail: `Source ${source.name} is ${source.company_type}; target ${target.name} is ${target.company_type}.`,
    mismatches:
      source.company_type === "erp" && target.company_type === "supplier_partner"
        ? []
        : ["Expected source type erp and target type supplier_partner."],
  });

  const readiness = await buildCutoverReadiness(sourceId, targetId);
  areas.push({
    area: "Cutover readiness",
    status: readiness.blockers.length === 0 ? "PASS" : "FAIL",
    detail: `${readiness.blockers.length} blocker(s), ${readiness.deltas.length} final delta(s).`,
    mismatches: readiness.blockers.map((item: Record<string, unknown>) => `${item.code}: ${item.message}`),
  });

  const suspense = await getSuspenseReview(sourceId, targetId);
  areas.push({
    area: "Migration Suspense",
    status: suspense.count === 0 ? "PASS" : "FAIL",
    detail:
      suspense.count === 0
        ? "No migrated entry remains in Migration Suspense."
        : `${suspense.count} entry row(s) require mapping.`,
    mismatches: suspense.items
      .slice(0, 50)
      .map(
        (item: Record<string, unknown>) =>
          `${item.target_voucher_number ?? item.target_voucher_id}: ${item.source_account_name ?? item.review_reason}`
      ),
  });

  const voucherCheck = await db.execute(sql`
    SELECT
      COUNT(*)::int AS voucher_count,
      COUNT(*) FILTER (WHERE totals.debit_total <> totals.credit_total)::int AS unbalanced_count,
      COUNT(*) FILTER (WHERE totals.entry_count < 2)::int AS incomplete_count
    FROM (
      SELECT v.id,
             ROUND(COALESCE(SUM(e.debit_amount::numeric), 0), 2) AS debit_total,
             ROUND(COALESCE(SUM(e.credit_amount::numeric), 0), 2) AS credit_total,
             COUNT(e.id)::int AS entry_count
      FROM vouchers v
      LEFT JOIN voucher_entries e ON e.voucher_id = v.id
      WHERE v.company_id = ${targetId}
        AND v.deleted_at IS NULL
        AND v.source_module IN ('SP_MIGRATION', 'SP_MIGRATION_READONLY', 'SP')
      GROUP BY v.id
    ) totals
  `);
  const voucherTotals = firstRow(voucherCheck) ?? {};
  const voucherFailures = pn(voucherTotals.unbalanced_count) + pn(voucherTotals.incomplete_count);
  areas.push({
    area: "Voucher integrity",
    status: voucherFailures === 0 ? "PASS" : "FAIL",
    detail: `${pn(voucherTotals.voucher_count)} SP/migration voucher(s); ${pn(voucherTotals.unbalanced_count)} unbalanced; ${pn(voucherTotals.incomplete_count)} incomplete.`,
    mismatches: voucherFailures
      ? ["All SP and migrated vouchers must have at least two entries and equal debit/credit totals."]
      : [],
  });

  const supplierLinkCheck = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM sp_containers c
    JOIN vouchers v ON v.id = c.goods_otw_voucher_id
    WHERE c.company_id = ${targetId}
      AND c.supplier_id IS NOT NULL
      AND v.supplier_id IS DISTINCT FROM c.supplier_id
  `);
  const supplierLinkGap = pn(firstRow(supplierLinkCheck)?.count);
  areas.push({
    area: "Supplier voucher links",
    status: supplierLinkGap === 0 ? "PASS" : "FAIL",
    detail:
      supplierLinkGap === 0
        ? "All Goods-OTW vouchers match their SP container supplier."
        : `${supplierLinkGap} Goods-OTW voucher(s) have a supplier mismatch.`,
    mismatches: supplierLinkGap ? ["Run SP Setup repair and re-run verification."] : [],
  });

  const sourceStock = await db.execute(sql`
    SELECT COALESCE(SUM(quantity::numeric), 0) AS qty,
           COALESCE(SUM(total_value::numeric), 0) AS value
    FROM inventory WHERE company_id = ${sourceId}
  `);
  const targetStock = await db.execute(sql`
    SELECT COALESCE(SUM(quantity::numeric), 0) AS qty,
           COALESCE(SUM(total_value::numeric), 0) AS value
    FROM inventory WHERE company_id = ${targetId}
  `);
  const srcStock = firstRow(sourceStock) ?? {};
  const tgtStock = firstRow(targetStock) ?? {};
  const qtyDiff = Math.abs(pn(srcStock.qty) - pn(tgtStock.qty));
  const valueDiff = Math.abs(pn(srcStock.value) - pn(tgtStock.value));
  areas.push({
    area: "Stock totals",
    status: qtyDiff <= 0.0001 && valueDiff <= 0.01 ? "PASS" : "WARN",
    detail: `Source qty ${pn(srcStock.qty).toFixed(4)} / value ${pn(srcStock.value).toFixed(2)}; target qty ${pn(tgtStock.qty).toFixed(4)} / value ${pn(tgtStock.value).toFixed(2)}.`,
    mismatches:
      qtyDiff <= 0.0001 && valueDiff <= 0.01
        ? []
        : [`Quantity difference ${qtyDiff.toFixed(4)}; value difference ${valueDiff.toFixed(2)}.`],
  });

  const orphanCheck = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM sp_container_lines l LEFT JOIN sp_containers c ON c.id = l.container_id
       WHERE l.company_id = ${targetId} AND c.id IS NULL)::int AS orphan_lines,
      (SELECT COUNT(*) FROM sp_stock_movements m LEFT JOIN stock_items s ON s.id = m.stock_item_id
       WHERE m.company_id = ${targetId} AND m.stock_item_id IS NOT NULL AND s.id IS NULL)::int AS orphan_movements,
      (SELECT COUNT(*) FROM sp_sale_lines l LEFT JOIN sp_sales s ON s.id = l.sale_id
       WHERE l.company_id = ${targetId} AND s.id IS NULL)::int AS orphan_sale_lines
  `);
  const orphans = firstRow(orphanCheck) ?? {};
  const orphanTotal = pn(orphans.orphan_lines) + pn(orphans.orphan_movements) + pn(orphans.orphan_sale_lines);
  areas.push({
    area: "Referential integrity",
    status: orphanTotal === 0 ? "PASS" : "FAIL",
    detail: `${pn(orphans.orphan_lines)} orphan container line(s), ${pn(orphans.orphan_movements)} orphan stock movement(s), ${pn(orphans.orphan_sale_lines)} orphan sale line(s).`,
    mismatches: orphanTotal ? ["Orphan SP child rows must be repaired before activation."] : [],
  });

  const userAccess = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE role <> 'Developer')::int AS old_non_developer_roles,
      (SELECT COUNT(*) FROM user_company_roles WHERE company_id = ${targetId})::int AS target_roles
    FROM user_company_roles
    WHERE company_id = ${sourceId}
  `);
  const access = firstRow(userAccess) ?? {};
  const cutover = await getLiveCutover(sourceId, targetId);
  const activated = cutover?.status === "active";
  const oldRoleCount = pn(access.old_non_developer_roles);
  areas.push({
    area: "User access",
    status: !activated || oldRoleCount === 0 ? "PASS" : "FAIL",
    detail: activated
      ? `${oldRoleCount} non-developer role(s) remain on old ERP; ${pn(access.target_roles)} role(s) exist on target.`
      : `Cutover is not active; ${pn(access.target_roles)} target role(s) are prepared.`,
    mismatches:
      activated && oldRoleCount ? ["After activation, only Developer support access may remain on the old ERP."] : [],
  });

  const rollbackEvidence = cutover
    ? await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM sp_migration_cutover_role_changes WHERE cutover_id = ${cutover.id})::int AS role_rows,
          (SELECT COUNT(*) FROM sp_migration_cutover_stock_deltas WHERE cutover_id = ${cutover.id})::int AS stock_rows
      `)
    : null;
  const evidence = firstRow<{ role_rows: number | null; stock_rows: number | null }>(rollbackEvidence) ?? {
    role_rows: 0,
    stock_rows: 0,
  };
  areas.push({
    area: "Rollback evidence",
    status: !cutover || pn(evidence.role_rows) + pn(evidence.stock_rows) > 0 ? "PASS" : "WARN",
    detail: cutover
      ? `${pn(evidence.role_rows)} user-role rollback row(s), ${pn(evidence.stock_rows)} stock rollback row(s).`
      : "No active cutover exists; rollback evidence will be created during finalization.",
    mismatches:
      cutover && pn(evidence.role_rows) + pn(evidence.stock_rows) === 0
        ? ["Active cutover has no recorded rollback evidence."]
        : [],
  });

  const overall = summarizeVerification(areas);
  return {
    overall,
    sourceCompanyId: sourceId,
    targetCompanyId: targetId,
    sourceCompany: { id: source.id, code: source.code, name: source.name },
    targetCompany: { id: target.id, code: target.code, name: target.name },
    cutoverStatus: cutover?.status ?? null,
    generatedAt: new Date().toISOString(),
    areas,
    counts: {
      pass: areas.filter((area) => area.status === "PASS").length,
      warn: areas.filter((area) => area.status === "WARN").length,
      fail: areas.filter((area) => area.status === "FAIL").length,
    },
  };
}

export function registerSpMigrationFinalVerificationRoutes(app: Express): void {
  app.get(
    "/api/sp/migration/final-verification",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const sourceId = Number.parseInt(String(req.query.sourceCompanyId ?? ""), 10);
        const targetId = Number.parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!sourceId || !targetId) {
          return res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });
        }
        if (sourceId === targetId) {
          return res.status(400).json({ message: "Source and target companies must be different" });
        }
        const report = await buildFinalSpVerification(sourceId, targetId);
        return res.status(report.overall === "FAIL" ? 409 : 200).json(report);
      } catch (error: unknown) {
        logger.error("[SP Migration] final verification error", { error });
        return res.status(500).json({ message: "Final Supplier Partner verification failed" });
      }
    }
  );
}
