/** Phase 4: all ERP, Factory and Rentals cash/bank statements share this API. */
import type { Express, Request, Response } from "express";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth";
import { db } from "../db";
import { upload } from "./_helpers";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  CashBankError,
  cashBankStatementDetailTx,
  importCashBankStatementTx,
  listCashBankAccountsTx,
  listCashBankStatementsTx,
  loadCashBankAccountTx,
  matchCashBankLineTx,
  voidCashBankMatchTx,
  reviewCashBankLineTx,
} from "../services/accounting/cashBankReconciliationService";
import {
  BankStatementParseError,
  parseCashBankStatement,
  statementDate,
} from "../services/accounting/cashBankStatementParser";
const kind = z.enum(["bank", "ledger"]);
const positiveId = z.coerce.number().int().positive();
const date = z.string().min(10).max(10);
const selector = z.object({ accountKind: kind, accountId: positiveId });
const postImport = z.object({
  accountKind: kind,
  accountId: positiveId,
  currency: z.string().length(3),
  periodStart: date,
  periodEnd: date,
  openingBalance: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
  closingBalance: z.string().regex(/^-?\d+(?:\.\d{1,6})?$/),
});
const postMatch = z.object({
  statementLineId: positiveId,
  voucherEntryId: positiveId,
  reason: z.string().max(1000).optional().nullable(),
});
function company(req: Request): number {
  const value = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new CashBankError("CASH_BANK_COMPANY_REQUIRED", "Select a company", 400);
  return value;
}
function actor(req: Request) {
  return {
    userId: String(req.session.userId ?? ""),
    username: String(req.session.username ?? req.session.userId ?? "unknown"),
  };
}
function fail(res: Response, error: unknown) {
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({ code: "CASH_BANK_REQUEST_INVALID", message: error.issues.map((x) => x.message).join("; ") });
  if (error instanceof BankStatementParseError)
    return res.status(400).json({ code: error.code, message: error.message });
  if (error instanceof CashBankError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  return res.status(500).json({ code: "CASH_BANK_INTERNAL_ERROR", message: getErrorMessage(error) });
}
export function registerCashBankReconciliationRoutes(app: Express): void {
  const gate = [requireAuth, requireRole("Admin", "Owner", "Developer")] as const;
  app.get("/api/accounting/cash-bank/accounts", ...gate, async (req, res) => {
    try {
      return res.json(await db.transaction((tx) => listCashBankAccountsTx(tx, company(req))));
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/cash-bank/statements", ...gate, async (req, res) => {
    try {
      const input = selector.parse(req.query),
        c = company(req);
      return res.json(await db.transaction((tx) => listCashBankStatementsTx(tx, { ...input, companyId: c })));
    } catch (e) {
      return fail(res, e);
    }
  });
  app.get("/api/accounting/cash-bank/statements/:id", ...gate, async (req, res) => {
    try {
      const c = company(req),
        statementId = positiveId.parse(req.params.id);
      return res.json(await db.transaction((tx) => cashBankStatementDetailTx(tx, c, statementId)));
    } catch (e) {
      return fail(res, e);
    }
  });
  // Preview only parses and checks balances; it stores no documents.
  app.post("/api/accounting/cash-bank/preview", ...gate, upload.single("file"), async (req: Request, res: Response) => {
    try {
      const companyId = company(req),
        input = postImport.parse(req.body);
      if (!req.file) throw new CashBankError("CASH_BANK_FILE_REQUIRED", "Select a CSV or XLSX file", 400);
      const periodStart = statementDate(input.periodStart),
        periodEnd = statementDate(input.periodEnd);
      const parsed = await parseCashBankStatement(req.file, periodStart, periodEnd);
      // Account ownership is checked even for preview.
      await db.transaction(async (tx) => {
        await loadCashBankAccountTx(tx, { companyId, accountKind: input.accountKind, accountId: input.accountId });
      });
      const sum = parsed.reduce((total, row) => total.plus(row.signedAmount), new Decimal(0));
      const starting = new Decimal(input.openingBalance),
        closing = new Decimal(input.closingBalance);
      if ([starting, closing].some((v) => !v.isFinite() || v.decimalPlaces() > 6 || v.abs().gte("100000000000000")))
        throw new CashBankError("CASH_BANK_PRECISION", "Enter a valid balance within six decimals", 400);
      const calculated = starting.plus(sum);
      return res.json({
        rowCount: parsed.length,
        lines: parsed.slice(0, 50),
        calculatedClosing: calculated.toFixed(6),
        suppliedClosing: closing.toFixed(6),
        balanced: calculated.eq(closing),
        fileFingerprint: createHash("sha256").update(req.file.buffer).digest("hex"),
        currency: input.currency.toUpperCase(),
      });
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/cash-bank/import", ...gate, upload.single("file"), async (req: Request, res: Response) => {
    try {
      const companyId = company(req),
        input = postImport.parse(req.body);
      if (!req.file) throw new CashBankError("CASH_BANK_FILE_REQUIRED", "Select a CSV or XLSX file", 400);
      const periodStart = statementDate(input.periodStart),
        periodEnd = statementDate(input.periodEnd);
      const lines = await parseCashBankStatement(req.file, periodStart, periodEnd);
      const data = await db.transaction((tx) =>
        importCashBankStatementTx(tx, {
          ...input,
          companyId,
          periodStart,
          periodEnd,
          fileName: req.file!.originalname,
          fileBytes: req.file!.buffer,
          lines,
          actor: actor(req),
        })
      );
      return res.status(data.replayed ? 200 : 201).json(data);
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/cash-bank/lines/:id/review", ...gate, async (req, res) => {
    try {
      const companyId = company(req),
        statementLineId = positiveId.parse(req.params.id);
      const payload = z
        .object({
          category: z
            .enum(["bank_fee", "transfer", "unidentified_receipt", "unidentified_payment", "other"])
            .nullable(),
          note: z.string().max(1500).nullable().optional(),
        })
        .parse(req.body);
      return res.json(
        await db.transaction((tx) =>
          reviewCashBankLineTx(tx, {
            companyId,
            statementLineId,
            category: payload.category,
            note: payload.note ?? null,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/cash-bank/matches", ...gate, async (req, res) => {
    try {
      const body = postMatch.parse(req.body),
        companyId = company(req);
      const outcome = await db.transaction((tx) =>
        matchCashBankLineTx(tx, {
          ...body,
          companyId,
          actor: actor(req),
        })
      );
      return res.status(outcome.replayed ? 200 : 201).json(outcome);
    } catch (e) {
      return fail(res, e);
    }
  });
  app.post("/api/accounting/cash-bank/matches/:id/void", ...gate, async (req, res) => {
    try {
      const companyId = company(req),
        matchId = positiveId.parse(req.params.id);
      const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
      return res.json(
        await db.transaction((tx) =>
          voidCashBankMatchTx(tx, {
            companyId,
            matchId,
            reason: body.reason,
            actor: actor(req),
          })
        )
      );
    } catch (e) {
      return fail(res, e);
    }
  });
}
