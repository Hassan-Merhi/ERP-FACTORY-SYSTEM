// Extracted from ./offloadRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { emptyQuery, validateRequest, type RequestSchemas } from "../lib/validateRequest";
import { z } from "zod";
import { assertActiveCompanyAccess, sendCompanyAccessError } from "../security/companyAccessBoundary";
import { containerOffloads, containers, locations } from "@shared/schema";
import {
  findContainerChargeVoucherDriftTx,
  repairContainerChargeVoucherDriftTx,
} from "../services/containers/offload-lifecycle/charge-voucher-repair";
import { registerOffloadRoutesPart3 } from "./registerOffloadRoutesPart3";

/**
 * The state the caller asked for, when it stated one.
 *
 * The suspend/restore button knows which direction it means, and saying so is
 * what lets a retransmission be recognized as a replay instead of being served
 * as a second toggle in the opposite direction. Legacy callers send no body and
 * keep the pure toggle behaviour.
 */
export function requestedOptionalState(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).optional;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

// No body, or no offloadIds, repairs every drifted offload of the company.
const repairOffloadChargeVouchersInput = {
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ offloadIds: z.array(z.union([z.number(), z.string()])).optional() })]),
} satisfies RequestSchemas;

export function registerOffloadRoutesPart1(app: Express) {
  // Offloads whose DUTY/OFFICE/TRANS/XFER vouchers were edited before voucher
  // edits re-priced the bales: preview the mismatch, then apply it.
  app.get(
    "/api/admin/offload-charge-voucher-repair",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const drift = await db.transaction((tx) => findContainerChargeVoucherDriftTx(tx, access.activeCompanyId));
        res.json({ drift });
      } catch (error: unknown) {
        logger.error("Offload charge voucher repair preview failed", { error: getErrorMessage(error) });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  app.post(
    "/api/admin/offload-charge-voucher-repair",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    validateRequest(repairOffloadChargeVouchersInput),
    async (req, res) => {
      try {
        const access = await assertActiveCompanyAccess(req);
        const rawIds: unknown = req.body?.offloadIds;
        const offloadIds = Array.isArray(rawIds)
          ? rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
          : undefined;
        const result = await db.transaction((tx) =>
          repairContainerChargeVoucherDriftTx(tx, access.activeCompanyId, offloadIds)
        );
        logger.info("Offload charge voucher repair applied", {
          module: "containers",
          action: "offload-charge-voucher-repair",
          companyId: access.activeCompanyId,
          userId: req.session.userId,
          repaired: result.repaired.map((row) => ({
            offloadId: row.offloadId,
            containerNumber: row.containerNumber,
            prefix: row.prefix,
            chargeDelta: row.chargeDelta,
          })),
        });
        res.json(result);
      } catch (error: unknown) {
        logger.error("Offload charge voucher repair failed", { error: getErrorMessage(error) });
        return sendCompanyAccessError(res, error);
      }
    }
  );

  // List offloads for daybook view (filtered by date range and company)
  app.get("/api/offloads", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const companyId = access.activeCompanyId;

      const { startDate, endDate } = req.query;
      const conditions = [eq(containers.companyId, companyId)];

      if (startDate) {
        conditions.push(gte(containerOffloads.offloadedAt, new Date((startDate as string) + "T00:00:00")));
      }
      if (endDate) {
        conditions.push(lte(containerOffloads.offloadedAt, new Date((endDate as string) + "T23:59:59")));
      }

      const offloads = await db
        .select({
          id: containerOffloads.id,
          containerId: containerOffloads.containerId,
          containerNumber: containers.containerNumber,
          locationId: containerOffloads.locationId,
          locationName: locations.name,
          duties: containerOffloads.duties,
          officeCharges: containerOffloads.officeCharges,
          transferCharges: containerOffloads.transferCharges,
          transportFees: containerOffloads.transportFees,
          totalCharges: containerOffloads.totalCharges,
          totalBales: containerOffloads.totalBales,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
          offloadedAt: containerOffloads.offloadedAt,
          itemsTotal: sql<string>`coalesce((select sum(coi.total_value) from container_offload_items coi where coi.offload_id = ${containerOffloads.id}), 0)`,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .leftJoin(locations, eq(containerOffloads.locationId, locations.id))
        .where(and(...conditions))
        .orderBy(desc(containerOffloads.offloadedAt))
        .execute();

      res.json(offloads);
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  registerOffloadRoutesPart3(app);
}
