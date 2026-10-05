import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { factoryContainers, customerOrders, customers, containers } from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull } from "drizzle-orm";

export function registerOrderTrackingRoutes(app: Express) {
  app.get("/api/factory/invoice-container-tracking", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db
        .select({
          id: customerOrders.id,
          invoiceNumber: customerOrders.invoiceNumber,
          containerNumber: customerOrders.containerNumber,
          status: customerOrders.status,
          grandTotal: customerOrders.grandTotal,
          orderDate: customerOrders.orderDate,
          customerName: customers.legalName,
          // ERP container tracking fields
          eta: containers.eta,
          trackingLink: containers.trackingLink,
          containerStatus: containers.status,
        })
        .from(customerOrders)
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .leftJoin(containers, eq(customerOrders.containerNumber, containers.containerNumber))
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            isNull(customerOrders.deletedAt),
            sql`${customerOrders.status} IN ('VERIFIED', 'FINALIZED')`,
            sql`${customerOrders.containerNumber} IS NOT NULL AND TRIM(${customerOrders.containerNumber}) <> ''`
          )
        )
        .orderBy(desc(customerOrders.orderDate), desc(customerOrders.id));

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Live carrier tracking is disabled. Container ETA/status/location are maintained manually or by import.
  app.post("/api/factory/shipping-containers/track-now", requireAuth, async (_req: Request, res: Response) => {
    return res.status(410).json({
      message: "Automatic container tracking is disabled. Update container data manually or by Excel import.",
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // REPAIR PER-KG LOADING PRICES
  // Finds LOADING/PENDING_VERIFICATION orders whose bales have priceUsed=0
  // but the proforma uses per_kg pricing, and recomputes each bale's price
  // using its real weight × pricePerKg.  Idempotent: already-correct bales
  // (priceUsed > 0) are left untouched.
  // ─────────────────────────────────────────────────────────────────────
}
