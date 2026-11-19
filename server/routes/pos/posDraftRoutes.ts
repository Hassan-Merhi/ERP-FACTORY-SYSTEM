import { type Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { InsertDraftPosSale, userLocations } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";

interface LastSoldPriceRow {
  stock_item_id: number;
  selling_price: string;
}

// The POS screen, its autosave and the legacy offline queue send drafts in this
// shape (client/src/pages/pos/hooks/usePosMutations.ts, usePosAutosave.ts).
const numberOrString = z.union([z.number(), z.string()]);
const draftItem = z.strictObject({
  stockItemId: numberOrString,
  quantity: numberOrString,
  rate: numberOrString,
  amount: numberOrString,
});
const draftFields = {
  locationId: numberOrString.nullable().optional(),
  paymentAccountType: z.string().nullable().optional(),
  paymentAccountId: numberOrString.nullable().optional(),
  isCreditSale: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional(),
  items: z.array(draftItem).nullable().optional(),
};

const createDraftInput = { query: emptyQuery, body: z.strictObject(draftFields) } satisfies RequestSchemas;
const updateDraftInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject(draftFields),
} satisfies RequestSchemas;
const deleteDraftInput = { params: stringIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerPosDraftRoutes(app: Express): void {
  // Last sold price stays company-wide, but the response only includes stock
  // items that exist at the active location. POS cannot select unrelated items,
  // so sending their prices wastes bandwidth without changing behavior.
  app.get("/api/pos/last-sold-prices", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.query.locationId as string);
      if (!locationId || isNaN(locationId)) {
        return res.status(400).json({ message: "Location ID is required" });
      }
      const companyId = req.session.currentCompanyId;
      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied: Invalid location" });
      }
      if (req.user?.role === "POS") {
        const assignedLocs = await db
          .select({ locationId: userLocations.locationId })
          .from(userLocations)
          .where(and(eq(userLocations.userId, req.user.id), eq(userLocations.companyId, companyId!)));
        const allowedIds = assignedLocs.map((l) => l.locationId);
        if (!allowedIds.includes(locationId)) {
          return res.status(403).json({ message: "You can only access data for your assigned locations" });
        }
      }

      const result = await pool.query(
        `SELECT DISTINCT ON (si.stock_item_id)
           si.stock_item_id,
           si.selling_price
         FROM sales_items si
         INNER JOIN vouchers v ON si.voucher_id = v.id
         WHERE v.company_id = $1
           AND EXISTS (
             SELECT 1
             FROM inventory i
             WHERE i.location_id = $2
               AND i.stock_item_id = si.stock_item_id
           )
         ORDER BY si.stock_item_id, v.voucher_date DESC, si.created_at DESC`,
        [companyId, locationId]
      );
      const prices: Record<number, string> = {};
      for (const row of result.rows as LastSoldPriceRow[]) prices[row.stock_item_id] = row.selling_price;
      res.setHeader("Cache-Control", "private, no-cache");
      return res.json(prices);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Lightweight draft summaries for the current user. Full draft contents are
  // fetched only from /api/pos/drafts/:id when the user opens one.
  app.get("/api/pos/drafts", requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const locationId = req.query.locationId ? parseInt(req.query.locationId as string) : undefined;
      const drafts = await storage.getAllDraftPosSales(userId, locationId);
      return res.json(drafts);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/drafts/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const draft = await storage.getDraftPosSaleById(id);

      if (!draft) {
        return res.status(404).json({ message: "Draft not found" });
      }
      if (draft.userId !== req.user?.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      return res.json(draft);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/drafts", requireAuth, validateRequest(createDraftInput), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const { locationId, paymentAccountType, paymentAccountId, isCreditSale, notes, items } = req.body;

      if (!locationId) {
        return res.status(400).json({ message: "Location is required" });
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      const draftData: InsertDraftPosSale = {
        userId,
        locationId,
        paymentAccountType: paymentAccountType || null,
        paymentAccountId: paymentAccountId || null,
        isCreditSale: isCreditSale || false,
        notes: notes || null,
      };

      const draft = await storage.createDraftPosSale(draftData, items);
      return res.status(201).json(draft);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/pos/drafts/:id", requireAuth, validateRequest(updateDraftInput), async (req, res) => {
    try {
      const id = parseInt(validatedInput(req, updateDraftInput).params.id);
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const existingDraft = await storage.getDraftPosSaleById(id);
      if (!existingDraft) {
        return res.status(404).json({ message: "Draft not found" });
      }
      if (existingDraft.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      const { locationId, paymentAccountType, paymentAccountId, isCreditSale, notes, items } = req.body;

      const updateData: Partial<InsertDraftPosSale> = {};
      if (locationId !== undefined) updateData.locationId = locationId;
      if (paymentAccountType !== undefined) updateData.paymentAccountType = paymentAccountType;
      if (paymentAccountId !== undefined) updateData.paymentAccountId = paymentAccountId;
      if (isCreditSale !== undefined) updateData.isCreditSale = isCreditSale;
      if (notes !== undefined) updateData.notes = notes;

      const draft = await storage.updateDraftPosSale(id, updateData, items);
      return res.json(draft);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/pos/drafts/:id", requireAuth, validateRequest(deleteDraftInput), async (req, res) => {
    try {
      const id = parseInt(validatedInput(req, deleteDraftInput).params.id);
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const existingDraft = await storage.getDraftPosSaleById(id);
      if (!existingDraft) {
        return res.status(404).json({ message: "Draft not found" });
      }
      if (existingDraft.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteDraftPosSale(id);
      return res.status(204).send();
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
