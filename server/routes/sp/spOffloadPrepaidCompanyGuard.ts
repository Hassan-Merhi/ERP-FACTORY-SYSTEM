import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSpCompany } from "./spHelpers";

type OffloadChargeLine = {
  chargeType?: unknown;
  prepaidChargeId?: unknown;
};

/**
 * Fail closed before the legacy offload handler can lock or mutate a prepaid
 * charge. The offload handler historically looked prepaid rows up by ID only,
 * so a stale or crafted request could reference a prepaid row owned by another
 * company. Keeping this guard ahead of registerSpOffloadRoutes makes company
 * ownership an explicit route invariant without changing normal offload flow.
 */
export function registerSpOffloadPrepaidCompanyGuard(app: Express) {
  app.post(
    "/api/sp/offload",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = await requireSpCompany(req, res);
        if (!companyId) return;

        const charges = Array.isArray(req.body?.chargeLines)
          ? (req.body.chargeLines as OffloadChargeLine[])
          : [];

        const prepaidCharges = charges.filter((charge) => charge?.chargeType === "prepaid_used");
        const prepaidIds: number[] = [];

        for (const charge of prepaidCharges) {
          const rawId = charge.prepaidChargeId;
          const normalized = typeof rawId === "number" ? String(rawId) : String(rawId ?? "").trim();
          const prepaidId = Number(normalized);

          // Do not let malformed/missing prepaid references fall through to the
          // legacy handler's generic clearing-account branch. A prepaid_used line
          // must always point at one concrete prepaid asset owned by this company.
          if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(prepaidId) || prepaidId <= 0) {
            return res.status(400).json({
              message: "prepaidChargeId is required and must be a positive integer for prepaid_used charges",
            });
          }

          if (!prepaidIds.includes(prepaidId)) prepaidIds.push(prepaidId);
        }

        if (prepaidIds.length > 0) {
          const rows = await db.execute<{ id: number }>(sql`
            SELECT id
            FROM sp_prepaid_charges
            WHERE company_id = ${companyId}
              AND id IN (${sql.join(
                prepaidIds.map((prepaidId) => sql`${prepaidId}`),
                sql`, `
              )})
          `);
          const matchedIds = new Set(rows.rows.map((row) => Number(row.id)));

          const missingPrepaidId = prepaidIds.find((prepaidId) => !matchedIds.has(prepaidId));
          if (missingPrepaidId !== undefined) {
            return res.status(400).json({
              message: `Prepaid charge #${missingPrepaidId} not found for this company`,
            });
          }
        }

        next();
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
