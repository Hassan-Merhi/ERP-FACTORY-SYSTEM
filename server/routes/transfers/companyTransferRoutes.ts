import type { Express } from "express";
import { insertInterCompanyTransferSchema } from "@shared/schema";
import { z } from "zod";

import { requireAuth, requireNonPOS } from "../../auth";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { interCompanyTransferService } from "./interCompanyTransferService";
import { sendTransferRouteError } from "./transferErrors";
import { getActiveTransferCompanyId, getTransferUserId, requireCompanyAccountAccess } from "./transferRequestContext";
import { simpleCompanyTransferService } from "./simpleCompanyTransferService";
import { parseCompanyId, parseTransferId } from "./transferValidation";

// Shapes only: the services still parse with their own schemas (and messages).
const transferRequestFields = {
  clientRequestId: z.string().optional(),
  currency: z.string().optional(),
  exchangeRate: z.string().optional(),
};

const interCompanyTransferInput = {
  query: emptyQuery,
  body: insertInterCompanyTransferSchema.extend(transferRequestFields).strict(),
} satisfies RequestSchemas;

const simpleTransferInput = {
  query: emptyQuery,
  body: z.strictObject({
    fromCompanyId: z.number(),
    toCompanyId: z.number(),
    fromLedgerAccountId: z.number(),
    toLedgerAccountId: z.number(),
    amount: z.string(),
    transferDate: z.string(),
    description: z.string().optional(),
    ...transferRequestFields,
  }),
} satisfies RequestSchemas;

const deleteSimpleTransferInput = {
  params: z.strictObject({ id: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerCompanyTransferRoutes(app: Express) {
  app.get("/api/inter-company-transfers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveTransferCompanyId(req);
      return res.json(await interCompanyTransferService.list(companyId));
    } catch (error: unknown) {
      return sendTransferRouteError(res, error, 500);
    }
  });

  app.post(
    "/api/inter-company-transfers",
    requireAuth,
    requireNonPOS,
    validateRequest(interCompanyTransferInput),
    async (req, res) => {
      try {
        getActiveTransferCompanyId(req);
        const userId = getTransferUserId(req);
        const transfer = await interCompanyTransferService.create(userId, req.body, {
          userId,
          username: req.session.username || "unknown",
          reason: "Inter-company transfer",
        });
        return res.status(201).json(transfer);
      } catch (error: unknown) {
        return sendTransferRouteError(res, error, 400);
      }
    }
  );

  app.get("/api/company-accounts/:companyId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = parseCompanyId(req.params.companyId);
      const userId = getTransferUserId(req);
      await requireCompanyAccountAccess(userId, companyId, req.session.currentCompanyId);
      return res.json(await simpleCompanyTransferService.listCompanyAccounts(companyId));
    } catch (error: unknown) {
      return sendTransferRouteError(res, error, 500);
    }
  });

  app.get("/api/simple-company-transfers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = getActiveTransferCompanyId(req);
      return res.json(await simpleCompanyTransferService.list(companyId));
    } catch (error: unknown) {
      return sendTransferRouteError(res, error, 500);
    }
  });

  app.post(
    "/api/simple-company-transfer",
    requireAuth,
    requireNonPOS,
    validateRequest(simpleTransferInput),
    async (req, res) => {
      try {
        const userId = getTransferUserId(req);
        const transfer = await simpleCompanyTransferService.create(userId, req.body, {
          userId,
          username: req.session.username || "unknown",
          reason: "Simple company transfer",
        });
        return res.status(201).json(transfer);
      } catch (error: unknown) {
        return sendTransferRouteError(res, error, 400);
      }
    }
  );

  app.delete(
    "/api/simple-company-transfer/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteSimpleTransferInput),
    async (req, res) => {
      try {
        const userId = getTransferUserId(req);
        const transferId = parseTransferId(req.params.id);
        return res.json(
          await simpleCompanyTransferService.delete(userId, transferId, {
            userId,
            username: req.session.username || "unknown",
            reason: `Reverse simple company transfer ${transferId}`,
          })
        );
      } catch (error: unknown) {
        return sendTransferRouteError(res, error, 500);
      }
    }
  );
}
