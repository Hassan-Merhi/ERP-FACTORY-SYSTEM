/**
 * factoryShippingContainerRoutes: ShippingAvailability endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryShippingAvailability, insertFactoryShippingAvailabilitySchema } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { getCompanyId } from "./_helpers";

export function registerShippingAvailabilityRoutes(app: Express) {
  // ── GET WhatsApp preview ──────────────────────────────────────────────────────
  // ── Shipping Availability CRUD ────────────────────────────────────────────────
  const AVAIL_KEY = "/api/factory/shipping-availability";

  app.get(AVAIL_KEY, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select()
        .from(factoryShippingAvailability)
        .where(eq(factoryShippingAvailability.companyId, companyId))
        .orderBy(desc(factoryShippingAvailability.date));
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post(AVAIL_KEY, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const parsed = insertFactoryShippingAvailabilitySchema.safeParse({ ...req.body, companyId });
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid data" });
      const [row] = await db.insert(factoryShippingAvailability).values(parsed.data).returning();
      res.json(row);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.patch(`${AVAIL_KEY}/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const { date, shippingCompany, availableContainers, note } = req.body;
      const updates: Record<string, unknown> = {};
      if (date !== undefined) {
        // A blank or unparseable date passed the !== undefined check and
        // reached the date column as-is, failing the query as a 500.
        if (typeof date !== "string" || date.trim() === "" || Number.isNaN(Date.parse(date))) {
          return res.status(400).json({ message: "Invalid request data", field: "date" });
        }
        updates.date = date;
      }
      if (shippingCompany !== undefined) updates.shippingCompany = shippingCompany;
      if (availableContainers !== undefined) {
        // Number("") is 0 and Number("abc") is NaN; neither belongs in an
        // integer column straight from the request body.
        const parsed = Number(availableContainers);
        if (!Number.isFinite(parsed)) {
          return res.status(400).json({ message: "Invalid request data", field: "availableContainers" });
        }
        updates.availableContainers = parsed;
      }
      if (note !== undefined) updates.note = note || null;
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "No fields to update" });
      const [row] = await db
        .update(factoryShippingAvailability)
        .set(updates)
        .where(and(eq(factoryShippingAvailability.id, id), eq(factoryShippingAvailability.companyId, companyId)))
        .returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.delete(`${AVAIL_KEY}/:id`, requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      await db
        .delete(factoryShippingAvailability)
        .where(and(eq(factoryShippingAvailability.id, id), eq(factoryShippingAvailability.companyId, companyId)));
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
