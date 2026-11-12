/**
 * Canonical Payment/Receipt interception for configured intercompany accounts.
 * This runs BEFORE both the central posting route and the legacy fallback.
 * Neither path may write a single-company voucher for a recognized pair.
 * All matched payments use confirmMirroredPayment's existing atomic, audited,
 * idempotent two-company journal (never post the ordinary voucher first).
 */
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { intercompanyRelationshipPolicies, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { IntercompanyEditError, type EditIdentity } from "../../services/intercompany/tradeSync";
import {
  matchNormalIntercompanyVoucher,
  NormalVoucherMirrorError,
  type NormalVoucherAccount,
} from "../../services/intercompany/normalVoucherMatching";
import { confirmMirroredPayment } from "../../services/intercompany/paymentSync";
import { getPairPaymentSetup } from "../../services/intercompany/paymentQueries";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";

const cash = z.object({ type: z.enum(["bank", "cash"]), id: z.number().int().positive() }).strict();
const allocation = z.object({
  tradeId: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  amount: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
}).strict();
const mirror = z.object({
  counterpartCashAccount: cash,
  transferReference: z.string().trim().min(5).max(180),
  confirmationEvidence: z.string().trim().min(8).max(2000),
  reason: z.string().trim().min(3).max(1000),
  confirmedBoth: z.literal(true),
  allocations: z.array(allocation).max(200).default([]),
}).strict();

const ordinary = z.object({
  voucherType: z.enum(["Payment", "Receipt"]),
  paymentAccountType: z.string().min(1),
  paymentAccountId: z.number().int().positive(),
  entries: z.array(z.object({
    accountType: z.string().min(1),
    accountId: z.number().int().positive(),
    amount: z.union([z.string(), z.number()]).optional(),
  }).passthrough()).min(1),
}).passthrough();

function actor(req: Request): EditIdentity {
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(companyId) || !req.session.userId) {
    throw new NormalVoucherMirrorError("IC_VOUCHER_SESSION", "Select an authorized company and sign in again", 403);
  }
  return {
    initiatingCompanyId: companyId,
    actorUserId: String(req.session.userId),
    actorRole: String(req.session.currentRole || ""),
  };
}

async function inspect(req: Request) {
  const identity = actor(req);
  if (!req.body || typeof req.body !== "object" || !["Payment", "Receipt"].includes(req.body.voucherType)) {
    return { identity, match: null };
  }
  // Fetch *only* relationships involving the signed-in company. Disabled
  // mappings are also detected, so they cannot bypass the paired posting
  // controls by falling through to an ordinary voucher.
  const policies = await db.select().from(intercompanyRelationshipPolicies).where(and(
    eq(intercompanyRelationshipPolicies.relationshipType, "container_trade"),
    or(
      eq(intercompanyRelationshipPolicies.sourceCompanyId, identity.initiatingCompanyId),
      eq(intercompanyRelationshipPolicies.destinationCompanyId, identity.initiatingCompanyId)
    )
  ));
  const body = req.body as {
    voucherType: string;
    paymentAccountType: string;
    paymentAccountId: number;
    entries: NormalVoucherAccount[];
  };
  const match = matchNormalIntercompanyVoucher({
    companyId: identity.initiatingCompanyId,
    voucherType: body.voucherType,
    paymentAccount: { accountType: body.paymentAccountType, accountId: Number(body.paymentAccountId) },
    entries: Array.isArray(body.entries) ? body.entries.map((row) => ({
      accountType: String(row.accountType),
      accountId: Number(row.accountId),
    })) : [],
    policies,
  });
  return { identity, match };
}

function fail(res: Response, error: unknown) {
  if (error instanceof NormalVoucherMirrorError || error instanceof IntercompanyEditError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return res.status(422).json({
      code: "IC_VOUCHER_INPUT",
      message: error.issues.map((issue) => issue.message).join("; "),
    });
  }
  logger.error("Normal voucher paired intercompany posting failed without writing either voucher", { error });
  return res.status(500).json({
    code: "IC_VOUCHER_INTERNAL",
    message: "The paired voucher could not be posted. No partial intercompany transfer was saved.",
  });
}

export function registerNormalIntercompanyVoucherRoutes(app: Express): void {
  // Read-only match resolves the partner automatically from the selected
  // account, never from an editable client relationship selector.
  app.post("/api/intercompany-container-trading/payments/voucher-preview", requireAuth, requireNonPOS, async (req, res) => {
    try {
      ordinary.parse(req.body);
      const { identity, match } = await inspect(req);
      if (!match) return res.json({ matched: false });
      const setup = await getPairPaymentSetup(match.relationshipId, identity);
      const counterpartCompanyId = match.role === "source-receipt"
        ? match.destinationCompanyId : match.sourceCompanyId;
      return res.json({
        matched: true,
        match,
        counterpartCashAccounts: setup.cashAccounts.filter((account) => account.companyId === counterpartCompanyId),
        purchaseOrders: setup.purchaseOrders,
        creditTotal: setup.credits,
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  // This middleware must be registered before both ordinary create handlers.
  app.post("/api/vouchers/payment-receipt", requireAuth, requireNonPOS, async (req, res, next: NextFunction) => {
    try {
      const { identity, match } = await inspect(req);
      if (!match) return next();
      if (isPhase9LanPrimary()) {
        throw new NormalVoucherMirrorError(
          "IC_VOUCHER_OFFLINE",
          "A two-company cash transfer needs both company ledgers online. Do not queue a standalone voucher.",
          409
        );
      }
      if (req.body.optional === true) {
        throw new NormalVoucherMirrorError(
          "IC_VOUCHER_DRAFT",
          "Save drafts without a posted intercompany balance; confirm the actual transfer before posting."
        );
      }
      const body = ordinary.parse(req.body);
      if (body.entries.length !== 1 || body.entries[0].amount == null) {
        throw new NormalVoucherMirrorError("IC_VOUCHER_ENTRY", "Enter exactly one positive intercompany amount");
      }
      const details = mirror.parse(req.body.intercompanyMirror);
      const reqId = req.body.clientRequestId;
      if (typeof reqId !== "string" || !/^[a-zA-Z0-9._:-]{8,110}$/.test(reqId)) {
        throw new NormalVoucherMirrorError(
          "IC_VOUCHER_IDEMPOTENCY",
          "The accounting request identity is missing. Refresh the voucher and retry.",
          422
        );
      }
      const currentCash = {
        type: body.paymentAccountType === "bank" ? "bank" as const : "cash" as const,
        id: body.paymentAccountId,
      };
      const sourceReceiptAccount = match.role === "source-receipt" ? currentCash : details.counterpartCashAccount;
      const destinationPaymentAccount = match.role === "destination-payment"
        ? currentCash : details.counterpartCashAccount;
      const result = await confirmMirroredPayment({
        relationshipId: match.relationshipId,
        requestKey: "ic-voucher:" + reqId,
        paymentDate: String(req.body.voucherDate),
        currency: String(req.body.currency || "USD") as "USD" | "CFA" | "ZMW",
        transactionAmount: String(body.entries[0].amount),
        historicalRate: String(req.body.currency === "USD" || !req.body.currency ? "1" : req.body.exchangeRate ?? ""),
        sourceReceiptAccount,
        destinationPaymentAccount,
        transferReference: details.transferReference,
        confirmationEvidence: details.confirmationEvidence,
        reason: details.reason,
        confirmedSourceReceipt: true,
        confirmedDestinationPayment: true,
        allocations: details.allocations,
      }, identity);
      return res.status(result.replayed ? 200 : 201).json({
        intercompanyMirrored: true,
        relationshipId: match.relationshipId,
        paymentId: result.paymentId,
        sourceVoucherId: result.sourceVoucherId,
        destinationVoucherId: result.destinationVoucherId,
        unallocatedCredit: result.unallocatedCredit,
        replayed: result.replayed,
        whatsapp: { prompt: false },
      });
    } catch (error) {
      return fail(res, error);
    }
  });

  // Editing an original mirrored voucher requires the paired reversal, and
  // a standalone editor cannot be used to inject a mapped company liability.
  app.patch("/api/vouchers/:id/payment-receipt", requireAuth, requireNonPOS, async (req, res, next) => {
    try {
      const identity = actor(req);
      const voucherId = Number(req.params.id);
      if (!Number.isSafeInteger(voucherId) || voucherId <= 0) return next();
      const [original] = await db.select({
        sourceModule: vouchers.sourceModule,
      }).from(vouchers).where(and(
        eq(vouchers.id, voucherId),
        eq(vouchers.companyId, identity.initiatingCompanyId)
      )).limit(1);
      if (original?.sourceModule === "INTERCOMPANY_CONTAINER") {
        throw new NormalVoucherMirrorError(
          "IC_VOUCHER_IMMUTABLE",
          "The paired cash vouchers are immutable. Reverse both company vouchers together from the linked payment history.",
          409
        );
      }
      const { match } = await inspect(req);
      if (match) {
        throw new NormalVoucherMirrorError("IC_VOUCHER_EDIT", "A linked company voucher cannot be edited as a single-company payment", 409);
      }
      return next();
    } catch (error) {
      return fail(res, error);
    }
  });
}
