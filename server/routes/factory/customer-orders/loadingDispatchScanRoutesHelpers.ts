// Extracted from ./loadingDispatchScanRoutes.ts
import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../../../db";
import { getFactoryAccessState } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";

export function canWrite(role: string): boolean {
  return !["view only", "create only"].includes(role.trim().toLowerCase());
}

export function canCorrect(role: string): boolean {
  return ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
}

export function validBarcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 ? trimmed : null;
}

export async function readContext(req: Request, res: Response) {
  const state = await getFactoryAccessState(req);
  if (!state) {
    res.status(403).json({ message: "Active Factory company access is unavailable" });
    return null;
  }
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) {
    res.status(400).json({ message: "Valid order and dispatch IDs are required" });
    return null;
  }
  return {
    companyId: state.companyId,
    orderId,
    dispatchId,
    role: state.role,
    userId: String(state.userId),
    username: String(req.session.username || state.userId),
  };
}

export async function readDuplicate(tx: DbTransaction, companyId: number, orderId: number, baleId: number) {
  const rows = await tx.execute(sql`
    SELECT s.id, s.bale_reference AS "baleReference",
           s.scanned_by_username AS "scannedByUsername",
           s.scanned_at AS "scannedAt",
           d.id AS "dispatchId", d.dispatch_number AS "dispatchNumber"
      FROM factory_loading_dispatch_scans s
      JOIN factory_loading_dispatches d ON d.id = s.dispatch_id
       AND d.company_id = s.company_id AND d.order_id = s.order_id
     WHERE s.company_id = ${companyId} AND s.order_id = ${orderId}
       AND s.bale_id = ${baleId} AND s.removed_at IS NULL
     LIMIT 1
  `);
  return resultRows(rows)[0] ?? null;
}
