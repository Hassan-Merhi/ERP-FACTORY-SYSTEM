import type { Express } from "express";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { parseId } from "../../lib/parseId";
import { upsertSupplierTrackingDefaultSchema } from "@shared/schema";
import {
  backfillSupplierTrackingDefaults,
  listSupplierTrackingDefaults,
  saveSupplierTrackingDefault,
} from "../../services/supplierTrackingDefaults";

const MANAGE_ROLES = ["Admin", "Owner", "Developer"] as const;

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
    async (req, res) => {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const supplierId = parseId(req.params.supplierId);
      if (supplierId === null) return res.status(400).json({ message: "Invalid supplier id" });

      const parsed = upsertSupplierTrackingDefaultSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid tracking default", errors: parsed.error.issues });
      }

      try {
        const saved = await saveSupplierTrackingDefault(req.session.currentCompanyId, supplierId, parsed.data);
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
