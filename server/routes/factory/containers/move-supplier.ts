/**
 * factoryContainersRoutes: FactoryContainerMoveSupplier endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factorySuppliers, factoryContainers } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// targetSupplierId is read with parseInt; optional so the handler keeps its message.
const moveSupplierInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ targetSupplierId: z.union([z.number(), z.string()]).optional() }),
} satisfies RequestSchemas;

export function registerFactoryContainerMoveSupplierRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // Move a container from one supplier to another.
  // The factory balance model is derived (containers − payments), so updating
  // supplierId is sufficient to shift the payable from old → new supplier.
  // If the target supplier is a linked/child supplier (has parentId), the
  // commissionSupplierId is automatically set to that parent (the broker).
  // ───────────────────────────────────────────────
  app.post(
    "/api/factory/containers/:id/move-supplier",
    requireAuth,
    validateRequest(moveSupplierInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const containerId = validatedInput(req, moveSupplierInput).params.id;

        const { targetSupplierId } = req.body;
        if (!targetSupplierId || isNaN(parseInt(targetSupplierId))) {
          return res.status(400).json({ message: "targetSupplierId is required" });
        }
        const targetId = parseInt(targetSupplierId);

        // Fetch container (must belong to this company and not be deleted)
        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.id, containerId),
              eq(factoryContainers.companyId, companyId),
              isNull(factoryContainers.deletedAt)
            )
          )
          .limit(1);
        if (!container) return res.status(404).json({ message: "Container not found" });
        if (container.supplierId === targetId) {
          return res.status(400).json({ message: "Container is already assigned to that supplier" });
        }

        // Fetch target supplier (must belong to same company)
        const [targetSupplier] = await db
          .select()
          .from(factorySuppliers)
          .where(and(eq(factorySuppliers.id, targetId), eq(factorySuppliers.companyId, companyId)))
          .limit(1);
        if (!targetSupplier) return res.status(404).json({ message: "Target supplier not found" });

        // Get old supplier name for the response
        let fromSupplierName = "Unknown";
        if (container.supplierId) {
          const [fromSup] = await db
            .select({ name: factorySuppliers.name })
            .from(factorySuppliers)
            .where(eq(factorySuppliers.id, container.supplierId))
            .limit(1);
          if (fromSup) fromSupplierName = fromSup.name;
        }

        // If the target is a linked child supplier, auto-set commission to its parent (the broker).
        // If the target is a standalone/broker with no parent, clear commission.
        const newCommissionSupplierId = targetSupplier.parentId ?? null;

        const [updated] = await db
          .update(factoryContainers)
          .set({ supplierId: targetId, commissionSupplierId: newCommissionSupplierId, updatedAt: new Date() })
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
          .returning();

        res.json({ container: updated, fromSupplierName, toSupplierName: targetSupplier.name });
      } catch (error: unknown) {
        logger.error("Error moving container supplier:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
