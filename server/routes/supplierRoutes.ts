import type { Express } from "express";

import { requireAuth, requireNonPOS } from "../auth";
import { sendSupplierRouteError } from "./suppliers/supplierErrors";
import {
  enforceSupplierCompanyQuery,
  getActiveSupplierCompanyId,
  getSupplierAuditActor,
  parseSupplierId,
} from "./suppliers/supplierRequestContext";
import { supplierService } from "./suppliers/supplierService";

export function registerSupplierRoutes(app: Express) {
  app.get("/api/suppliers", requireAuth, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      enforceSupplierCompanyQuery(req, companyId);
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const allowParentFallback = req.query.allowParentFallback === "true";
      return res.json(await supplierService.list(companyId, search, allowParentFallback));
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });

  // MUST come before /api/suppliers/:id to avoid route matching issues.
  app.get("/api/suppliers/stats", requireAuth, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      return res.json(await supplierService.stats(companyId));
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });

  app.get("/api/suppliers/:id", requireAuth, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplierId = parseSupplierId(req.params.id);
      return res.json(await supplierService.get(supplierId, companyId));
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });

  app.get("/api/suppliers/:id/balance", requireAuth, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplierId = parseSupplierId(req.params.id);
      return res.json(await supplierService.balance(supplierId, companyId));
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });

  app.post("/api/suppliers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplier = await supplierService.create(companyId, req.body, getSupplierAuditActor(req));
      return res.status(201).json(supplier);
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 400);
    }
  });

  app.patch("/api/suppliers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplierId = parseSupplierId(req.params.id);
      const supplier = await supplierService.update(
        supplierId,
        companyId,
        req.body,
        getSupplierAuditActor(req),
      );
      return res.json(supplier);
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 400);
    }
  });

  app.delete("/api/suppliers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplierId = parseSupplierId(req.params.id);
      await supplierService.delete(supplierId, companyId, getSupplierAuditActor(req));
      return res.status(204).send();
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });

  app.patch("/api/suppliers/:id/stock-group", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveSupplierCompanyId(req);
      const supplierId = parseSupplierId(req.params.id);
      const supplier = await supplierService.assignStockGroup(
        supplierId,
        companyId,
        req.body,
        getSupplierAuditActor(req),
      );
      return res.json({ success: true, supplier });
    } catch (error: unknown) {
      return sendSupplierRouteError(res, error, 500);
    }
  });
}
