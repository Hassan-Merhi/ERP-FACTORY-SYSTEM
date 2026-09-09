/**
 * Shared state and helpers for the factoryDispatchBatchRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryDispatchBatchRoutes.ts.
 */
import { db } from "../../../db";
import type { Request } from "express";
import { sql, eq, and } from "drizzle-orm";
import { customerDispatchBatches } from "@shared/schema";
import { firstRow } from "../../../lib/queryResult";

// ── helpers ──────────────────────────────────────────────────────────────────

export function getCompanyId(req: Request): number | null {
  return req.session.factoryCompanyId || req.session.currentCompanyId || null;
}

export function getUsername(req: Request): string {
  // `session.user` carries only `role` and is never assigned anywhere in the
  // server, so the old `session.user?.username` fallback could never produce a
  // name; `session.username` is the value login actually stores.
  return req.session.username || "unknown";
}

export async function isAdmin(req: Request, companyId: number): Promise<boolean> {
  try {
    const userId = req.session.userId;
    if (!userId) return false;
    const rows = await db.execute(
      sql`SELECT role FROM user_company_roles WHERE company_id = ${companyId} AND user_id = ${String(userId)} LIMIT 1`
    );
    const row = firstRow(rows);
    return row?.role === "Admin";
  } catch {
    return false;
  }
}

// Recalculate and update the batch totals — not needed for batches themselves
// but we do need to update batch status to LOADING when first ride is created
export async function ensureBatchStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  batchId: number,
  companyId: number,
  status: string
) {
  await tx
    .update(customerDispatchBatches)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
}

// ── route registration ────────────────────────────────────────────────────────
