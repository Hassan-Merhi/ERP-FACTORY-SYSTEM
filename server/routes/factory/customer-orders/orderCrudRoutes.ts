import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseOptionalId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBales, customerOrders, insertCustomerOrderSchema } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import { guardProformaOrderCreation } from "./proformaCapacityWriteGuards";
import { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";
import { requireCreateOnlyVerifiedCreate } from "../../../services/security/createOnlyVerifiedCreates";
import { registerOrderCrudRoutesPart1 } from "./registerOrderCrudRoutesPart1";
import { registerOrderCrudRoutesPart2 } from "./registerOrderCrudRoutesPart2";
import { registerOrderCrudRoutesPart3 } from "./registerOrderCrudRoutesPart3";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// The handler re-parses with insertCustomerOrderSchema after forcing companyId
// and status, so the body is that insert shape. Clients send companyId (the
// invoice create page) and tests send status; both are overwritten. Orders have
// no currency column: the insert parse always dropped `currency`, which the
// factory mobile browser fixture (scripts/lib/factory-mobile-fixture.mjs) sends.
const createOrderInput = {
  query: emptyQuery,
  body: insertCustomerOrderSchema
    .omit({ companyId: true, status: true })
    .extend({
      companyId: z.unknown().optional(),
      status: z.unknown().optional(),
      currency: z.unknown().optional(),
    })
    .strict(),
} satisfies RequestSchemas;

export function registerOrderCrudRoutes(app: Express) {
  registerOrderCrudRoutesPart1(app);
  registerOrderCrudRoutesPart2(app);

  // Create Only may add a new DRAFT order dated today (createOnlyVerifiedCreates.ts).
  const createOnlyOrder = requireCreateOnlyVerifiedCreate("factoryCustomerOrders");
  app.post(
    "/api/factory/customer-orders",
    requireAuth,
    createOnlyOrder,
    validateRequest(createOrderInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });

        // Guard and insert in one locked transaction. Guarding outside it let two
        // orders for the same proforma each read the last remaining slot.
        const creation = await db.transaction(async (tx) => {
          if (parsed.proformaIdUsed) {
            await acquireProformaCapacityTransactionLock(tx, {
              companyId,
              proformaId: parsed.proformaIdUsed,
            });
            const guard = await guardProformaOrderCreation(tx, {
              companyId,
              proformaId: parsed.proformaIdUsed,
              customerId: parsed.customerId,
            });
            if (!guard.allowed) return { ok: false, rejection: guard } as const;
          }
          const [created] = await tx.insert(customerOrders).values(parsed).returning();
          // Phase 21 (B): the create audit commits with the order.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || req.session.userId!,
              companyId,
              action: "create",
              tableName: "factory_customer_orders",
              recordId: created.id,
              recordIdentifier: orderAuditIdentifier(created, created.id),
              changes: null,
            },
            tx
          );
          return { ok: true, order: created } as const;
        });

        if (!creation.ok) return res.status(creation.rejection.status).json(creation.rejection.body);
        const order = creation.order;
        res.json(order);
      } catch (error: unknown) {
        logger.error("Error creating customer order:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
  registerOrderCrudRoutesPart3(app);
  registerOrderCrudRoutesPart4(app);

  // ───────────────────────────────────────────────
  // INVOICE EXPORT (Excel/CSV)
  // ───────────────────────────────────────────────
}

function registerOrderCrudRoutesPart4(app: Express) {
  // ───────────────────────────────────────────────
  // BALE SCAN LOOKUP
  // ───────────────────────────────────────────────

  app.get("/api/factory/bale-lookup", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const code = req.query.code as string;
      const locationId = req.query.locationId ? parseOptionalId(req.query.locationId) : null;
      if (!code) return res.status(400).json({ message: "code is required" });

      const conditions = [
        eq(factoryBales.companyId, companyId),
        eq(factoryBales.status, "IN_STOCK"),
        or(eq(factoryBales.referenceNumber, code), eq(factoryBales.baleCode, code), eq(factoryBales.articleCode, code)),
      ];

      if (locationId) {
        conditions.push(eq(factoryBales.erpLocationId, locationId));
      }

      const results = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions));

      if (results.length === 0)
        return res.status(404).json({ message: "No available bale found with that code at this location" });

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
