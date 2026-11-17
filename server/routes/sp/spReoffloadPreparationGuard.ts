import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";
import { resultRows, firstRow } from "../../lib/queryResult";

/**
 * The legacy offload concurrency guard treats every historical sp_offloads row
 * as active. After a fully audited reversal, archive the old operational rows
 * immediately before corrected re-offload. The immutable reversal row retains
 * the complete offload, charge, movement and voucher snapshot.
 */
async function prepareCorrectedReoffload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;

    const containerId = Number(req.body?.containerId);
    if (!Number.isInteger(containerId) || containerId <= 0) {
      next();
      return;
    }

    await db.transaction(async (tx) => {
      const containerResult = await tx.execute(sql`
        SELECT status
        FROM sp_containers
        WHERE id = ${containerId} AND company_id = ${companyId}
        FOR UPDATE
      `);
      const container =
        firstRow(containerResult) ??
        (containerResult as unknown as { [key: string]: Record<string, unknown> | undefined })[0];
      if (!container || container.status !== "open") return;

      const reversedRows = await tx.execute(sql`
        SELECT r.offload_id
        FROM sp_offload_reversals r
        JOIN sp_offloads o ON o.id = r.offload_id
        WHERE r.company_id = ${companyId}
          AND r.container_id = ${containerId}
          AND o.company_id = ${companyId}
        ORDER BY r.id
        FOR UPDATE OF o
      `);
      const reversedOffloadIds = (resultRows(reversedRows) ?? []).map((row) => Number(row.offload_id));
      if (reversedOffloadIds.length === 0) return;

      await tx.execute(sql`
        DELETE FROM sp_offload_charges c
        USING sp_offload_reversals r
        WHERE c.offload_id = r.offload_id
          AND c.company_id = ${companyId}
          AND r.company_id = ${companyId}
          AND r.container_id = ${containerId}
      `);
      await tx.execute(sql`
        DELETE FROM sp_offloads o
        USING sp_offload_reversals r
        WHERE o.id = r.offload_id
          AND o.company_id = ${companyId}
          AND r.company_id = ${companyId}
          AND r.container_id = ${containerId}
      `);
    });

    next();
  } catch (error: unknown) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpReoffloadPreparationGuard(app: Express): void {
  app.post("/api/sp/offload", requireAuth, (req, res, next) => {
    void prepareCorrectedReoffload(req, res, next);
  });
}
