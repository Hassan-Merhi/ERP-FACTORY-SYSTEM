/** Phase 4 endpoints: no payment or credit action works outside the signed-in company pair. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { logger } from "../../lib/logger";
import { IntercompanyEditError, type EditIdentity } from "../../services/intercompany/tradeSync";
import { confirmMirroredPayment, reverseMirroredPayment } from "../../services/intercompany/paymentSync";
import {
  getPairPaymentSetup,
  getPairPaymentHistory,
  listPaymentRelationships,
} from "../../services/intercompany/paymentQueries";

const id = z.coerce.number().int().positive();
const amount = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .max(28);
const nativeAmount = z
  .string()
  .regex(/^\d+(?:\.\d{1,2})?$/)
  .max(28);
const rate = z
  .string()
  .regex(/^\d+(?:\.\d{1,10})?$/)
  .max(36);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const cash = z.object({ type: z.enum(["bank", "cash"]), id: z.number().int().positive() }).strict();
const item = z
  .object({ tradeId: z.number().int().positive(), expectedVersion: z.number().int().positive(), amount })
  .strict();
const confirm = z
  .object({
    relationshipId: z.number().int().positive(),
    requestKey: key,
    paymentDate: day,
    currency: z.enum(["USD", "CFA", "ZMW"]),
    transactionAmount: nativeAmount,
    historicalRate: rate,
    sourceReceiptAccount: cash,
    destinationPaymentAccount: cash,
    transferReference: z.string().trim().min(5).max(180),
    confirmationEvidence: z.string().trim().min(8).max(2000),
    reason: z.string().trim().min(3).max(1000),
    confirmedSourceReceipt: z.literal(true),
    confirmedDestinationPayment: z.literal(true),
    allocations: z.array(item).max(200),
  })
  .strict();
const reversal = z
  .object({
    requestKey: key,
    reversalDate: day,
    reason: z.string().trim().min(3).max(1000),
    confirmedSourceReversal: z.literal(true),
    confirmedDestinationReversal: z.literal(true),
  })
  .strict();
function actor(req: Request): EditIdentity {
  const companyId = Number(req.session.currentCompanyId);
  if (
    !Number.isSafeInteger(companyId) ||
    companyId < 1 ||
    !req.session.userId ||
    !["Owner", "Admin", "Developer"].includes(String(req.session.currentRole))
  ) {
    throw new IntercompanyEditError(
      "IC_PAYMENT_FORBIDDEN",
      "Sign in as an Owner, Admin or Developer in an involved company",
      403
    );
  }
  return {
    initiatingCompanyId: companyId,
    actorUserId: String(req.session.userId),
    actorRole: String(req.session.currentRole),
  };
}
function fail(res: Response, error: unknown) {
  if (error instanceof IntercompanyEditError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
    });
  if (error instanceof z.ZodError)
    return res.status(422).json({
      code: "IC_PAYMENT_INPUT",
      message: error.issues.map((x) => x.message).join("; "),
    });
  logger.error("Mirrored intercompany payment failed", { error });
  return res
    .status(500)
    .json({
      code: "IC_PAYMENT_INTERNAL",
      message: "No partial mirrored payment was saved. Correct the evidence and retry.",
    });
}
export function registerIntercompanyPhase4Routes(app: Express) {
  app.get("/api/intercompany-container-trading/payments/relationships", requireAuth, async (req, res) => {
    try {
      return res.json(await listPaymentRelationships(actor(req)));
    } catch (error) {
      return fail(res, error);
    }
  });
  app.get("/api/intercompany-container-trading/payments/pairs/:relationshipId/setup", requireAuth, async (req, res) => {
    try {
      return res.json(await getPairPaymentSetup(id.parse(req.params.relationshipId), actor(req)));
    } catch (error) {
      return fail(res, error);
    }
  });
  app.get(
    "/api/intercompany-container-trading/payments/pairs/:relationshipId/history",
    requireAuth,
    async (req, res) => {
      try {
        return res.json(await getPairPaymentHistory(id.parse(req.params.relationshipId), actor(req)));
      } catch (error) {
        return fail(res, error);
      }
    }
  );
  app.post("/api/intercompany-container-trading/payments/confirm", requireAuth, async (req, res) => {
    try {
      return res.status(201).json(await confirmMirroredPayment(confirm.parse(req.body), actor(req)));
    } catch (error) {
      return fail(res, error);
    }
  });
  app.post("/api/intercompany-container-trading/payments/:paymentId/reverse", requireAuth, async (req, res) => {
    try {
      return res.json(
        await reverseMirroredPayment(
          {
            ...reversal.parse(req.body),
            paymentId: id.parse(req.params.paymentId),
          },
          actor(req)
        )
      );
    } catch (error) {
      return fail(res, error);
    }
  });
}
