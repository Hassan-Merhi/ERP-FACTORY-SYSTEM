// Extracted from ./spGoldenCoastExistingPositionCarryForwardRoutes.ts
import type { Request } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { spStockMovements, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { type CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../../services/accounting/goldenCoastCutoverMarkers";
import { goldenCoastPhase3VoucherNumber } from "../../services/accounting/goldenCoastPhase3Cutover";
import {
  type ExistingPositionInventoryRow,
  type ExistingPositionOtwContainerRow,
} from "../../services/accounting/goldenCoastExistingPositionCarryForward";
import { GOLDEN_COAST_CUTOVER_FIFO_SOURCE } from "../../services/accounting/goldenCoastPhase4CutoverFifo";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export async function loadInventory(
  conn: typeof db | DatabaseTransaction,
  companyId: number
): Promise<ExistingPositionInventoryRow[]> {
  const rows = await conn.execute(sql`
    SELECT inv.id AS inventory_id,
           inv.location_id,
           inv.stock_item_id,
           inv.quantity,
           inv.average_rate,
           loc.name AS location_name,
           si.code AS article_code,
           si.name AS description
    FROM inventory inv
    INNER JOIN locations loc ON loc.id = inv.location_id AND loc.company_id = ${companyId}
    INNER JOIN stock_items si ON si.id = inv.stock_item_id
    WHERE inv.company_id = ${companyId}
    ORDER BY inv.location_id, inv.stock_item_id, inv.id
  `);
  return resultRows(rows).map((row) => ({
    inventoryId: Number(row.inventory_id),
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    articleCode: String(row.article_code ?? ""),
    description: row.description == null ? null : String(row.description),
    quantity: String(row.quantity ?? "0"),
    averageRate: String(row.average_rate ?? "0"),
    locationName: row.location_name == null ? null : String(row.location_name),
  }));
}

export async function loadOtwContainers(
  conn: typeof db | DatabaseTransaction,
  companyId: number
): Promise<ExistingPositionOtwContainerRow[]> {
  const rows = await conn.execute(sql`
    SELECT id AS container_id,
           container_number,
           CAST(COALESCE(grand_total, items_total, '0') AS numeric) AS value_usd
    FROM containers
    WHERE company_id = ${companyId} AND status = 'OTW'
    ORDER BY id
  `);
  return resultRows(rows).map((row) => ({
    containerId: Number(row.container_id),
    containerNumber: String(row.container_number ?? ""),
    valueUsd: String(row.value_usd ?? "0"),
  }));
}

export async function loadExistingVoucher(conn: typeof db | DatabaseTransaction, companyId: number) {
  const [row] = await conn
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherNumber, goldenCoastExistingPositionCarryForwardVoucherNumber(companyId)),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function loadExistingPhase3Voucher(conn: typeof db | DatabaseTransaction, companyId: number) {
  const [row] = await conn
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherNumber, goldenCoastPhase3VoucherNumber(companyId)),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function loadExistingBridge(conn: typeof db | DatabaseTransaction, companyId: number) {
  const rows = await conn
    .select()
    .from(spStockMovements)
    .where(
      and(eq(spStockMovements.companyId, companyId), eq(spStockMovements.sourceType, GOLDEN_COAST_CUTOVER_FIFO_SOURCE))
    );
  return rows;
}

export async function recordCarryForwardAudit(
  tx: DatabaseTransaction,
  req: Request,
  companyId: number,
  voucherId: number,
  replayed: boolean
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO sp_audit_events(
      company_id, user_id, username, role, permission, action, method, path,
      entity_id, reason, confirmation, idempotency_key, status_code, request_body
    ) VALUES (
      ${companyId},
      ${req.user?.id ?? req.session.userId ?? null},
      ${req.session.username ?? null},
      ${req.user?.role ?? req.session.currentRole ?? null},
      'sp_migration',
      'EXISTING_POSITION_CARRY_FORWARD',
      'POST',
      ${req.originalUrl},
      ${String(voucherId)},
      ${String(req.body?.reason ?? "").trim() || null},
      ${String(req.body?.confirmation ?? "").trim() || null},
      ${String(req.header("Idempotency-Key") ?? req.body?.idempotencyKey ?? "").trim() || null},
      200,
      ${JSON.stringify({ replayed })}::jsonb
    )
  `);
}
