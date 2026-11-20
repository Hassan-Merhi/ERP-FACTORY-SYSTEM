import type { Express } from "express";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  positiveIntParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../lib/validateRequest";
import { upsertSupplierTrackingDefaultSchema } from "@shared/schema";
import {
  backfillSupplierTrackingDefaults,
  listSupplierTrackingDefaults,
  saveSupplierTrackingDefault,
} from "../../services/supplierTrackingDefaults";

const MANAGE_ROLES = ["Admin", "Owner", "Developer"] as const;

const saveDefaultInput = {
  params: z.strictObject({ supplierId: positiveIntParam }),
  query: emptyQuery,
  body: upsertSupplierTrackingDefaultSchema.strict(),
} satisfies RequestSchemas;

const backfillInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerSupplierTrackingDefaultRoutes(app: Express) {
  app.get("/api/tracking-defaults/suppliers", requireAuth, requireNonPOS, async (req, res) => {
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    try {
      return res.json(await listSupplierTrackingDefaults(req.session.currentCompanyId));
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put(
    "/api/tracking-defaults/suppliers/:supplierId",
    requireAuth,
    requireNonPOS,
    requireRole(...MANAGE_ROLES),
    validateRequest(saveDefaultInput),
    async (req, res) => {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const { params, body } = validatedInput(req, saveDefaultInput);

      try {
        const saved = await saveSupplierTrackingDefault(req.session.currentCompanyId, params.supplierId, body);
        return res.json({ success: true, default: saved });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        const status = message.includes("not found in the selected company") ? 400 : 500;
        return res.status(status).json({ message });
      }
    }
  );

  app.post(
    "/api/tracking-defaults/backfill",
    requireAuth,
    requireNonPOS,
    requireRole(...MANAGE_ROLES),
    validateRequest(backfillInput),
    async (req, res) => {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      try {
        const result = await backfillSupplierTrackingDefaults(req.session.currentCompanyId);
        return res.json({ success: true, ...result });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
