import type { Express } from "express";

import { requireAuth, requireNonPOS } from "../../auth";
import { sendCustomerRouteError } from "./customerErrors";
import { getActiveCustomerCompanyId, getCustomerAuditActor, parseCustomerId } from "./customerRequestContext";
import { customerService } from "./customerService";
import { logger } from "../../lib/logger";
import { getMonetaryFxValuation } from "../../services/accounting/monetaryFxValuationService";
import { applyCurrentCustomerFxOverlay } from "../../services/accounting/monetaryFxReportOverlay";
import { requireCreateOnlyVerifiedCreate } from "../../services/security/createOnlyVerifiedCreates";
import { z } from "zod";
import { insertCustomerSchema } from "@shared/schema";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// customerService re-parses the body with insertCustomerSchema and answers its
// own 400s, so every column stays optional here.
const customerFields = insertCustomerSchema.omit({ companyId: true }).partial();
// parseCustomerId answers its own 400 for a bad id.
const customerIdParams = z.strictObject({ id: stringParam });

const createCustomerInput = {
  query: emptyQuery,
  // A companyId other than the session company is refused with 403 below.
  body: customerFields.extend({ companyId: z.union([z.number(), z.string()]).optional() }).strict(),
} satisfies RequestSchemas;

const updateCustomerInput = {
  params: customerIdParams,
  query: emptyQuery,
  body: customerFields
    .extend({
      companyId: z.unknown().optional(), // sent by client/src/pages/useCompanyCustomersState.tsx; removed by the service
      id: z.unknown().optional(), // sent by client/src/pages/useCompanyCustomersState.tsx; not used
      // Checked for duplicates by the service, then dropped by insertCustomerSchema.
      code: z.string().optional(),
    })
    .strict(),
} satisfies RequestSchemas;

const deleteCustomerInput = { params: customerIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

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
      const bookRows = await customerService.stats(companyId);
      try {
        const valuation = await getMonetaryFxValuation(companyId);
        return res.json(applyCurrentCustomerFxOverlay(bookRows, valuation));
      } catch (error) {
        // Customer ledgers remain readable when native evidence or FX is missing.
        logger.error("[customers/stats] Monetary USD projection unavailable; preserving book balances", {
          companyId,
          error,
        });
        return res.json(bookRows);
      }
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

  app.post(
    "/api/customers",
    requireAuth,
    requireNonPOS,
    requireCreateOnlyVerifiedCreate("customers"),
    validateRequest(createCustomerInput),
    async (req, res) => {
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
    }
  );

  app.put("/api/customers/:id", requireAuth, requireNonPOS, validateRequest(updateCustomerInput), async (req, res) => {
    try {
      const companyId = getActiveCustomerCompanyId(req);
      const customerId = parseCustomerId(req.params.id);
      const customer = await customerService.update(customerId, companyId, req.body, getCustomerAuditActor(req));
      return res.json(customer);
    } catch (error: unknown) {
      return sendCustomerRouteError(res, error, 400);
    }
  });

  app.delete(
    "/api/customers/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteCustomerInput),
    async (req, res) => {
      try {
        const companyId = getActiveCustomerCompanyId(req);
        const customerId = parseCustomerId(req.params.id);
        await customerService.delete(customerId, companyId, getCustomerAuditActor(req));
        return res.status(204).send();
      } catch (error: unknown) {
        return sendCustomerRouteError(res, error, 500);
      }
    }
  );
}
