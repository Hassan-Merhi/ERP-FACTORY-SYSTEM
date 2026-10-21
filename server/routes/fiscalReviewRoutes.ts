/** Phase 13: fiscal close readiness, dual approval, audited reviewed-close. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { getErrorMessage } from "../lib/httpHandlers";
import { resultRows } from "../lib/queryResult";
import { sql } from "drizzle-orm";
import { closeFiscalPeriod, FiscalPeriodCloseError } from "../storage/accounting/fiscal-periods";
import {
  FiscalReviewError,
  fiscalReadinessTx,
  recordFiscalReviewTx,
  revokeFiscalReviewTx,
  ensureReviewedFiscalCloseTx,
  recordReviewedFiscalCloseTx,
  reviewedFiscalCloseHistoryTx,
  fiscalReviewPolicyTx,
  setFiscalReviewPolicyTx,
} from "../services/accounting/fiscalReviewService";
import { assertTransactionCompanyScope } from "../services/security/transactionCompanyScope";
import {
  UNIFIED_FINANCIAL_POSTING_LOCKED,
  UNIFIED_FINANCIAL_POSTING_RELEASED,
} from "../middleware/unifiedAccountingRolloutBoundary";
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.coerce.number().int().positive();
const reviewScope = z.object({
  periodStartDate: iso,
  periodEndDate: iso,
  retainedEarningsAccountId: id,
});
const signed = z.object({
  ...reviewScope.shape,
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewKind: z.enum(["ACCOUNTING", "OWNER"]),
  note: z.string().trim().min(10).max(2000),
});
const close = z.object({
  ...reviewScope.shape,
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().max(2000).optional(),
});
function company(req: Request) {
  const n = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new FiscalReviewError("FISCAL_COMPANY_REQUIRED", "Select a company", 400);
  return n;
}
function person(req: Request) {
  const userId = String(req.session.userId ?? "").trim();
  if (!userId) throw new FiscalReviewError("FISCAL_ACTOR_MISSING", "Login required", 401);
  return { userId, username: String(req.session.username ?? userId) };
}
function allowedSignoff(req: Request, kind: "ACCOUNTING" | "OWNER") {
  const role = String(req.session.currentRole ?? "");
  const acceptable = kind === "OWNER" ? role === "Owner" : role === "Admin" || role === "Developer";
  if (!acceptable)
    throw new FiscalReviewError(
      "FISCAL_ROLE_REQUIRED",
      kind === "OWNER" ? "Owner signoff requires an Owner account" : "Accounting signoff requires Admin or Developer",
      403
    );
}
function failure(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({
      code: "FISCAL_REVIEW_REQUEST_INVALID",
      message: error.issues.map((x) => x.message).join("; "),
    });
  if (error instanceof FiscalReviewError)
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
    });
  if (error instanceof FiscalPeriodCloseError)
    return res.status(error.status).json({
      code: "FISCAL_CLOSE_REJECTED",
      message: error.message,
    });
  const code = (error as { code?: string })?.code;
  if (code === "23505")
    return res.status(409).json({
      code: "FISCAL_SIGNOFF_CONFLICT",
      message: "A current review signoff already exists for this period and role",
    });
  const message = getErrorMessage(error);
  if (/DATE_INVALID|PERIOD_INVALID|FUTURE_DATE/i.test(message))
    return res.status(400).json({ code: "FISCAL_REVIEW_DATE_INVALID", message });
  return res.status(500).json({
    code: "FISCAL_REVIEW_OPERATION_FAILED",
    message: "Fiscal review could not be completed; no closing journal was posted by this request",
  });
}
export function registerFiscalReviewRoutes(app: Express) {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/fiscal-review/policy", ...gate, async (req: Request, res: Response) => {
    try {
      const companyId = company(req);
      const policy = await db.transaction((tx) => fiscalReviewPolicyTx(tx, companyId));
      res.setHeader("Cache-Control", "no-store");
      return res.json(policy);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/fiscal-review/policy", ...gate, async (req: Request, res: Response) => {
    try {
      allowedSignoff(req, "OWNER");
      const body = z.object({ enforce: z.boolean(), reason: z.string().trim().min(10).max(1000) }).parse(req.body);
      const companyId = company(req);
      return res.json(
        await db.transaction((tx) =>
          setFiscalReviewPolicyTx(tx, {
            companyId,
            enforce: body.enforce,
            reason: body.reason,
            actor: person(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/fiscal-review/equity-accounts", ...gate, async (req: Request, res: Response) => {
    try {
      const companyId = company(req);
      const accounts = await db.transaction(async (tx) => {
        await assertTransactionCompanyScope(tx, companyId);
        return resultRows<{ id: number; code: string; name: string } & Record<string, unknown>>(
          await tx.execute(sql`
     SELECT id,code,name FROM ledger_accounts WHERE company_id=${companyId}
       AND LOWER(TRIM(account_type))='equity'
       AND deleted_at IS NULL AND active=true
     ORDER BY code,id LIMIT 300
    `)
        );
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ companyId, accounts, limit: 300 });
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/fiscal-review/readiness", ...gate, async (req: Request, res: Response) => {
    try {
      const b = reviewScope.parse(req.query),
        companyId = company(req);
      const data = await db.transaction((tx) => fiscalReadinessTx(tx, { ...b, companyId }));
      res.setHeader("Cache-Control", "no-store");
      return res.json(data);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/fiscal-review/history", ...gate, async (req: Request, res: Response) => {
    try {
      const companyId = company(req);
      const history = await db.transaction((tx) => reviewedFiscalCloseHistoryTx(tx, companyId));
      res.setHeader("Cache-Control", "no-store");
      return res.json({ companyId, reviewedClosures: history, limit: 100 });
    } catch (e) {
      return failure(res, e);
    }
  });
  app.get("/api/accounting/fiscal-review/audit", ...gate, async (req: Request, res: Response) => {
    try {
      const companyId = company(req);
      const rows = await db.transaction(async (tx) => {
        await assertTransactionCompanyScope(tx, companyId);
        return resultRows<Record<string, unknown>>(
          await tx.execute(sql`
     SELECT id,action,table_name,record_id,record_identifier,
      user_id,username,created_at::text AS recorded_at,changes
     FROM audit_log WHERE company_id=${companyId}
      AND table_name IN(
       'fiscal_period_closures','accounting_fiscal_review_signoffs',
       'accounting_fiscal_reviewed_closures','accounting_fiscal_review_policy')
     ORDER BY id DESC LIMIT 250
    `)
        );
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ companyId, events: rows, limit: 250, provisional: false });
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/fiscal-review/signoffs", ...gate, async (req: Request, res: Response) => {
    try {
      const b = signed.parse(req.body),
        companyId = company(req);
      allowedSignoff(req, b.reviewKind);
      const record = await db.transaction((tx) =>
        recordFiscalReviewTx(tx, {
          ...b,
          companyId,
          reviewer: person(req),
        })
      );
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(record);
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/fiscal-review/signoffs/:id/revoke", ...gate, async (req: Request, res: Response) => {
    try {
      const companyId = company(req),
        signoffId = id.parse(req.params.id);
      const b = z.object({ reason: z.string().trim().min(10).max(1000) }).parse(req.body);
      // Only Owner may revoke signoffs to make approval-chain changes explicit
      // rather than allowing a mere budget/finance reporter to erase review.
      allowedSignoff(req, "OWNER");
      return res.json(
        await db.transaction((tx) =>
          revokeFiscalReviewTx(tx, {
            companyId,
            signoffId,
            reason: b.reason,
            actor: person(req),
          })
        )
      );
    } catch (e) {
      return failure(res, e);
    }
  });
  app.post("/api/accounting/fiscal-review/close", ...gate, async (req: Request, res: Response) => {
    // Defense in depth: never rely on the path-matching middleware alone.
    if (!UNIFIED_FINANCIAL_POSTING_RELEASED) return res.status(423).json(UNIFIED_FINANCIAL_POSTING_LOCKED);
    try {
      allowedSignoff(req, "OWNER");
      const b = close.parse(req.body),
        companyId = company(req),
        actor = person(req);
      let validated: { accountingSignoffId: number; ownerSignoffId: number; evidenceHash: string } | null = null;
      const closure = await closeFiscalPeriod(
        companyId,
        b.periodStartDate,
        b.periodEndDate,
        b.retainedEarningsAccountId,
        actor.userId,
        b.notes,
        actor,
        {
          beforeClose: async (tx) => {
            // This executes *after* the fiscal exclusive advisory lock in the
            // original writer, so signoff hashes and balances cannot race a post.
            validated = await ensureReviewedFiscalCloseTx(tx, { ...b, companyId });
          },
          afterClose: async (tx, posted) => {
            if (!validated) throw new FiscalReviewError("FISCAL_ATTESTATION_MISSING", "Fiscal close was not verified");
            await recordReviewedFiscalCloseTx(tx, {
              companyId,
              closureId: posted.id,
              voucherId: posted.closingVoucherId,
              ...validated,
              actor,
            });
          },
        }
      );
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({
        reviewed: true,
        closed: true,
        closureId: closure.id,
        closingVoucherId: closure.closingVoucherId,
        periodStartDate: closure.periodStartDate,
        periodEndDate: closure.periodEndDate,
      });
    } catch (e) {
      return failure(res, e);
    }
  });
}
