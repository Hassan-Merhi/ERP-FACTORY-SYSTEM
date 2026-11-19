// Extracted from ./loading.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { dispatchNotification } from "../../../../lib/notificationService";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry } from "../../_helpers";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { guardProformaOrderCreation } from "../proformaCapacityWriteGuards";
import { customerOrders, customers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { isFactorySessionLocation } from "../../../helpers/companyOwnership";

export function registerOrderLoadingRoutesPart1(app: Express) {
  app.post("/api/factory/customer-orders-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, proformaIdUsed, locationId, orderDate, containerNotes } = req.body;
      if (!customerId) return res.status(400).json({ message: "Customer is required" });
      if (!locationId) return res.status(400).json({ message: "Location is required" });
      if (!(await isFactorySessionLocation(req.session, locationId))) {
        return res.status(400).json({ message: "Location not found" });
      }

      const parsedCustomerId = parseInt(customerId);
      const parsedProformaId = proformaIdUsed ? parseInt(proformaIdUsed) : null;

      // Capacity is checked and the order is inserted inside one locked
      // transaction. Checking outside it let two loadings for the same proforma
      // each read the last remaining slot and both take it.
      const creation = await db.transaction(async (tx) => {
        if (parsedProformaId) {
          await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: parsedProformaId });
          const guard = await guardProformaOrderCreation(tx, {
            companyId,
            proformaId: parsedProformaId,
            customerId: parsedCustomerId,
          });
          if (!guard.allowed) return { ok: false, rejection: guard } as const;
        }

        const [created] = await tx
          .insert(customerOrders)
          .values({
            companyId,
            customerId: parsedCustomerId,
            proformaIdUsed: parsedProformaId,
            locationId: parseInt(locationId),
            orderDate: orderDate || getClientDate(req),
            status: "LOADING",
            loadingStartedAt: new Date(),
            containerNotes: containerNotes || null,
          })
          .returning();
        return { ok: true, order: created } as const;
      });

      if (!creation.ok) {
        return res.status(creation.rejection.status).json(creation.rejection.body);
      }
      const order = creation.order;

      const [loadingCustomer] = await db
        .select({ legalName: customers.legalName })
        .from(customers)
        .where(eq(customers.id, parseInt(customerId)));
      const loadingToday = orderDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: loadingToday,
        txType: "LOADING_CREATED",
        referenceId: order.id,
        referenceTable: "customer_orders",
        description: `Loading started for customer: ${loadingCustomer?.legalName || customerId}`,
      });

      dispatchNotification({
        eventType: "LOADING_STARTED",
        title: "Loading Started",
        message: `New loading started for ${loadingCustomer?.legalName || "customer"}`,
        entityType: "customer_order",
        entityId: order.id,
        triggeredByUserId: req.session?.userId ?? null,
        companyId,
      }).catch(() => {});

      res.json(order);
    } catch (error: unknown) {
      logger.error("Error creating loading order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
