// Extracted from ./priorityScanConfigRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { loadActivePriorityRows, PRIORITY_SCAN_LOCK_NAMESPACE, rewriteActivePriorityQueue } from "./priorityScanQueue";
import { isApprovedPriorityScanColor, PRIORITY_SCAN_COLORS } from "@shared/priorityScanColors";

const MAX_PRIORITY = 10_000;

export const PRIORITY_SCAN_LIST_PATH = "/api/factory/customer-orders/loading-list/priority-scan-configs";

export const PRIORITY_SCAN_ORDER_PATH = "/api/factory/customer-orders/:id/loading-list/priority-scan-config";

export const PRIORITY_SCAN_ROUTE_PATH = "/api/factory/customer-orders/loading-list/priority-scan-route";

export function normalizeColor(raw: unknown): { color: string; colorKey: string } | null {
  if (!isApprovedPriorityScanColor(raw)) return null;
  // Persist the approved canonical uppercase HEX value regardless of input casing.
  const color = PRIORITY_SCAN_COLORS.find((preset) => preset.toLowerCase() === raw.toLowerCase())!;
  return { color, colorKey: color.toLowerCase() };
}

export function parsePriority(raw: unknown): number | null {
  const priority = typeof raw === "number" ? raw : Number(raw);
  return Number.isSafeInteger(priority) && priority > 0 && priority <= MAX_PRIORITY ? priority : null;
}

export function canManagePriorityPosition(req: Request): boolean {
  const role = String(req.session.currentRole || req.session.role || req.user?.role || "").toLocaleLowerCase("en-US");
  return role === "admin" || role === "developer" || role === "owner";
}

export function uniqueConstraint(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; constraint?: unknown };
  return value.code === "23505" && typeof value.constraint === "string" ? value.constraint : null;
}

export function sendPriorityConflict(res: Response, constraint: string | null) {
  if (constraint === "copsc_active_color_unique") {
    return res.status(409).json({ message: "That color is already assigned to another active priority loading." });
  }
  if (constraint === "copsc_active_priority_unique") {
    return res.status(409).json({ message: "That priority is already assigned to another active priority loading." });
  }
  return res.status(409).json({ message: "Priority Scan configuration changed at the same time. Please try again." });
}

export async function disableStalePriorityScanConfigs(companyId: number): Promise<void> {
  // Stale cleanup is a QUEUE WRITE, even when triggered by a GET request.
  // Serialize it with stock-entry routing, manual scan, deletion/recovery,
  // and configuration edits. A read must never race a queue rewrite.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
    const disabled = await tx.execute(sql`
      UPDATE customer_order_priority_scan_configs AS config
      SET enabled = FALSE,
          updated_by = NULL,
          updated_by_name = 'system:stale-disabled',
          updated_at = now()
      FROM customer_orders AS order_row
      WHERE config.order_id = order_row.id
        AND config.company_id = ${companyId}
        AND order_row.company_id = ${companyId}
        AND config.enabled = TRUE
        AND (
          order_row.status <> 'LOADING'
          OR order_row.deleted_at IS NOT NULL
          OR order_row.proforma_id_used IS NULL
        )
      RETURNING config.id
    `);
    if (resultRows(disabled).length === 0) return;
    const active = await loadActivePriorityRows(tx, companyId);
    await rewriteActivePriorityQueue(
      tx,
      companyId,
      active.map((row) => row.id),
      null,
      "system:stale-compact"
    );
  });
}

export class PriorityScanConfigError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
