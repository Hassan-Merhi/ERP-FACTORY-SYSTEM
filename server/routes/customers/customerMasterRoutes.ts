import type { Express } from "express";

import { requireAuth, requireNonPOS } from "../../auth";
import { sendCustomerRouteError } from "./customerErrors";
import {
  getActiveCustomerCompanyId,
  getCustomerAuditActor,
  parseCustomerId,
} from "./customerRequestContext";
import { customerService } from "./customerService";

export function registerCustomerMasterRoutes(app: Express) {
  app.get("/api/customers/for-pos", requireAuth, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      return res.json(await customerService.forPos(companyId));
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });

  app.get("/api/customers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const search = typeof req.query.search === "string" ? req.query.search.trim() || undefined : undefined;
      return res.json(await customerService.list(companyId, search));
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });

  app.get("/api/customers/stats", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      return res.json(await customerService.stats(companyId));
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });

  app.get("/api/customers/:id/transactions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const customerId = parseCustomerId(req.params.id);
      const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
      return res.json(await customerService.transactions(customerId, companyId, startDate, endDate));
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });

  app.get("/api/customers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const customerId = parseCustomerId(req.params.id);
      return res.json(await customerService.get(customerId, companyId));
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });

  app.post("/api/customers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      if (req.body?.companyId !== undefined && Number(req.body.companyId) !== companyId) {
        return res.status(403).json({
          message: "Access denied: Customer belongs to a different company",
        });
      }
      const customer = await customerService.create(companyId, req.body, getCustomerAuditActor(req));
      return res.status(201).json(customer);
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 400);
    }
  });

  app.put("/api/customers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const customerId = parseCustomerId(req.params.id);
      const customer = await customerService.update(
        customerId,
        companyId,
        req.body,
        getCustomerAuditActor(req),
      );
      return res.json(customer);
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 400);
    }
  });

  app.delete("/api/customers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const customerId = parseCustomerId(req.params.id);
      await customerService.delete(customerId, companyId, getCustomerAuditActor(req));
      return res.status(204).send();
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 500);
    }
  });
}
