/**
 * factoryStockRoutes: FactoryStockRemoval endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { deletePhysicalFactoryBalesTx } from "./physicalBaleDeletion";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../customer-orders/priorityScanQueue";
import { verifySupervisorPassword } from "../_helpers";
import { factoryBales, users, userCompanyRoles } from "@shared/schema";
import { eq, and, sql, isNull, asc } from "drizzle-orm";

export function registerFactoryStockRemovalRoutes(app: Express) {
  app.post("/api/factory/stock-entry/remove", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { baleIds, supervisorUsername, supervisorPassword, reason } = req.body;

      if (
        !Array.isArray(baleIds) ||
        baleIds.length === 0 ||
        baleIds.length > 200 ||
        baleIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
        new Set(baleIds).size !== baleIds.length
      ) {
        return res.status(400).json({ message: "baleIds array is required" });
      }
      if (!supervisorUsername || !supervisorPassword) {
        return res.status(400).json({ message: "Supervisor credentials are required" });
      }

      const [supervisor] = await db.select().from(users).where(eq(users.username, supervisorUsername));

      if (!supervisor) {
        return res.status(403).json({ message: "Supervisor not found" });
      }

      const passwordValid = await verifySupervisorPassword(supervisorPassword, supervisor.password);
      if (!passwordValid) {
        return res.status(403).json({ message: "Invalid supervisor password" });
      }

      const [role] = await db
        .select()
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, supervisor.id), eq(userCompanyRoles.companyId, companyId)));

      if (!role || !["Admin", "Owner", "Manager", "Developer"].includes(role.role)) {
        return res.status(403).json({ message: "Supervisor must have Admin, Owner, or Manager role" });
      }

      const removed = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
        return deletePhysicalFactoryBalesTx(tx, {
          companyId,
          baleIds,
          actorId: String(supervisor.id),
          actorName: supervisorUsername,
          reason: reason || "Factory bale stock removal",
          businessDate: getClientDate(req),
        });
      });

      res.json({ removed: removed.length, bales: removed });
    } catch (error: unknown) {
      logger.error("Error removing bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Remove N bales of a specific product from a specific location
  app.post("/api/factory/stock-entry/remove-by-product", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { productId, locationId, qty, supervisorUsername, supervisorPassword, reason } = req.body;

      if (![productId, locationId, qty].every((value) => Number.isSafeInteger(value) && value > 0) || qty > 200) {
        return res.status(400).json({ message: "productId, locationId, and qty >= 1 are required" });
      }
      if (!supervisorUsername || !supervisorPassword) {
        return res.status(400).json({ message: "Supervisor credentials are required" });
      }

      const [supervisor] = await db.select().from(users).where(eq(users.username, supervisorUsername));

      if (!supervisor) return res.status(403).json({ message: "Supervisor not found" });

      const passwordValid = await verifySupervisorPassword(supervisorPassword, supervisor.password);
      if (!passwordValid) return res.status(403).json({ message: "Invalid supervisor password" });

      const [role] = await db
        .select()
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, supervisor.id), eq(userCompanyRoles.companyId, companyId)));

      if (!role || !["Admin", "Owner", "Manager", "Developer"].includes(role.role)) {
        return res.status(403).json({ message: "Supervisor must have Admin, Owner, or Manager role" });
      }

      const removed = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
        // Resolve the physical bale IDs while holding the priority lock. Do
        // not pick already-deleted stock, or another company's product.
        const selected = await tx
          .select({ id: factoryBales.id })
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.productId, productId),
              eq(factoryBales.erpLocationId, locationId),
              eq(factoryBales.status, "IN_STOCK"),
              isNull(factoryBales.deletedAt),
              // A quantity removal never picks bales already loaded on a live
              // customer loading (V5 loaded bales stay IN_STOCK). Those must be
              // removed explicitly so a supervisor sees which loading changes.
              sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id
               WHERE cob.bale_id = ${factoryBales.id} AND co.company_id = ${companyId}
                 AND co.status <> 'CANCELLED' AND co.deleted_at IS NULL)`
            )
          )
          .orderBy(asc(factoryBales.id))
          .limit(qty);
        if (selected.length !== qty)
          throw new Error(
            `Only ${selected.length} of ${qty} requested bales are available (unloaded) in stock at this location. Nothing was removed.`
          );
        return deletePhysicalFactoryBalesTx(tx, {
          companyId,
          baleIds: selected.map((row) => row.id),
          actorId: String(supervisor.id),
          actorName: supervisorUsername,
          reason: reason || "Factory bale stock removal",
          businessDate: getClientDate(req),
        });
      });

      res.json({ removed: removed.length, bales: removed });
    } catch (error: unknown) {
      logger.error("Error removing bales by product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
