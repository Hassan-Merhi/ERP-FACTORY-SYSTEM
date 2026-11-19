// Extracted from ./factoryInsuranceRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import {
  createMemberInput,
  extraChargeInput,
  importPreviewInput,
  memberActionInput,
  updateMemberInput,
} from "./factoryInsuranceRouteSchemas";
import {
  insertInsuranceMemberSchema,
  insuranceMembers,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { postBalancedVoucherTx, PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { infrastructurePostingIdentity } from "../../services/accounting/infrastructureVoucherIdentity";
import { isCompanyIsolationError, resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { spreadsheetUpload } from "../_helpers";
import { readExcel, writeWorkbook } from "../../excelHelper";
import { createInsuranceImportTemplate, parseInsuranceWorkbook } from "../../services/factory/insuranceWorkbookImport";
import { toMoney } from "../../lib/money";
import {
  errorMessage,
  findOrCreateLedger,
  insuranceExtraChargeSchema,
  sendRouteError,
} from "./factoryInsuranceRoutesHelpers";

export function registerFactoryInsuranceRoutesPart1(app: Express) {
  // Payroll & Benefits > Insurance owns this action, not the Vouchers page.
  // The shared /api/vouchers/with-entries endpoint remains Vouchers-only.
  app.post(
    "/api/insurance/extra-charges",
    requireAuth,
    requireNonPOS,
    requireFactoryTabAccess("factory/payroll-hub", "hide_tab_payrollhub_insurance"),
    validateRequest(extraChargeInput),
    async (req: Request, res: Response) => {
      const parsed = insuranceExtraChargeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid insurance extra charge", errors: parsed.error.issues });
      }

      try {
        const companyId = resolveRequestCompanyId(req);
        const { voucherDate, debitAccountId, creditAccountId, notes, clientRequestId } = parsed.data;
        const amount = toMoney(parsed.data.amount).toFixed(2);
        const narration = notes || "Insurance extra charge";

        const result = await db.transaction(async (tx) => {
          // Never accept an account from another company or a deleted account,
          // even when a caller bypasses the Insurance account picker.
          const ownedAccounts = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                inArray(ledgerAccounts.id, [debitAccountId, creditAccountId]),
                isNull(ledgerAccounts.deletedAt)
              )
            );
          if (ownedAccounts.length !== 2) {
            throw new PostingValidationError("POSTING_TARGET_NOT_OWNED", "An account is not available in this company");
          }

          return postBalancedVoucherTx(
            tx,
            {
              voucher: {
                companyId,
                voucherType: "Journal",
                voucherDate,
                totalAmount: amount,
                description: narration,
                currency: "USD",
                sourceModule: "ERP",
                optional: false,
              },
              entries: [
                { ledgerAccountId: debitAccountId, debitAmount: amount, creditAmount: "0", narration: notes || null },
                { ledgerAccountId: creditAccountId, debitAmount: "0", creditAmount: amount, narration: notes || null },
              ],
              source: infrastructurePostingIdentity(
                "factory-insurance-extra-charge",
                `${companyId}:${clientRequestId}`,
                "journal"
              ),
              actor: {
                userId: req.session.userId ?? null,
                username: req.session.username || "unknown",
                reason: "Add Insurance extra charge",
              },
            },
            createDatabasePostingDependencies()
          );
        });

        return res.json({
          voucherId: result.voucher.id,
          voucherNumber: result.voucher.voucherNumber,
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        logger.error("POST /api/insurance/extra-charges error:", { error });
        if (isCompanyIsolationError(error)) return res.status(403).json({ message: "Forbidden" });
        if (error instanceof PostingValidationError) {
          return res.status(error.code === "POSTING_IDEMPOTENCY_CONFLICT" ? 409 : 400).json({
            message: error.message,
            code: error.code,
          });
        }
        return res.status(500).json({ message: errorMessage(error, "Failed to post insurance extra charge") });
      }
    }
  );

  app.get("/api/insurance/members", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const includeInactive = req.query.includeInactive === "true";
      const where = includeInactive
        ? eq(insuranceMembers.companyId, companyId)
        : and(eq(insuranceMembers.companyId, companyId), eq(insuranceMembers.active, true));
      const rows = await db.select().from(insuranceMembers).where(where).orderBy(insuranceMembers.name);
      res.json(rows);
    } catch (error: unknown) {
      logger.error("GET /api/insurance/members error:", { error });
      sendRouteError(res, error, "Failed to fetch insurance members");
    }
  });

  app.get("/api/insurance/members/:id/entries", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const companyId = resolveRequestCompanyId(req);

      const [member] = await db
        .select({ ledgerAccountId: insuranceMembers.ledgerAccountId })
        .from(insuranceMembers)
        .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
        .limit(1);
      if (!member) return res.status(404).json({ message: "Member not found" });
      if (!member.ledgerAccountId) return res.json([]);

      const entries = await db
        .select({
          id: voucherEntries.id,
          voucherId: voucherEntries.voucherId,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          description: vouchers.description,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(and(eq(voucherEntries.ledgerAccountId, member.ledgerAccountId), eq(vouchers.companyId, companyId)))
        .orderBy(desc(vouchers.voucherDate), desc(vouchers.id));
      res.json(entries);
    } catch (error: unknown) {
      logger.error("GET /api/insurance/members/:id/entries error:", { error });
      sendRouteError(res, error, "Failed to fetch entries");
    }
  });

  app.post(
    "/api/insurance/members",
    requireAuth,
    validateRequest(createMemberInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        const parsed = insertInsuranceMemberSchema.safeParse({ ...req.body, companyId });
        if (!parsed.success) {
          return res.status(400).json({ message: "Validation failed", errors: parsed.error.issues });
        }
        const data = parsed.data;
        const ledger = await findOrCreateLedger(companyId, `Insurance - ${data.name}`, "Liability");
        const inserted = await pool.query(
          `INSERT INTO insurance_members
           (company_id, name, nationality, position_working, insurance_number,
            start_date, amount, dob, notes, active, ledger_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
          [
            companyId,
            data.name,
            data.nationality ?? null,
            data.positionWorking ?? null,
            data.insuranceNumber ?? null,
            data.startDate,
            data.amount,
            data.dob ?? null,
            data.notes ?? null,
            data.active ?? true,
            ledger.id,
          ]
        );
        res.status(201).json(inserted.rows[0]);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/members error:", { error });
        sendRouteError(res, error, "Failed to create insurance member");
      }
    }
  );

  app.patch(
    "/api/insurance/members/:id",
    requireAuth,
    validateRequest(updateMemberInput),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
        const companyId = resolveRequestCompanyId(req);
        const [existing] = await db
          .select({ name: insuranceMembers.name, ledgerAccountId: insuranceMembers.ledgerAccountId })
          .from(insuranceMembers)
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
          .limit(1);
        if (!existing) return res.status(404).json({ message: "Member not found" });

        const parsed = insertInsuranceMemberSchema.partial().omit({ companyId: true }).safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ message: "Validation failed", errors: parsed.error.issues });
        }
        const data = parsed.data;
        if (data.name && data.name !== existing.name && existing.ledgerAccountId) {
          await db
            .update(ledgerAccounts)
            .set({ name: `Insurance - ${data.name}` })
            .where(and(eq(ledgerAccounts.id, existing.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)));
        }
        const [updated] = await db
          .update(insuranceMembers)
          .set(data)
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
          .returning();
        res.json(updated);
      } catch (error: unknown) {
        logger.error("PATCH /api/insurance/members/:id error:", { error });
        sendRouteError(res, error, "Failed to update insurance member");
      }
    }
  );

  app.patch(
    "/api/insurance/members/:id/toggle",
    requireAuth,
    validateRequest(memberActionInput),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
        const companyId = resolveRequestCompanyId(req);
        const [existing] = await db
          .select({ active: insuranceMembers.active })
          .from(insuranceMembers)
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
          .limit(1);
        if (!existing) return res.status(404).json({ message: "Member not found" });
        const [updated] = await db
          .update(insuranceMembers)
          .set({ active: !existing.active })
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
          .returning();
        res.json(updated);
      } catch (error: unknown) {
        logger.error("PATCH /api/insurance/members/:id/toggle error:", { error });
        sendRouteError(res, error, "Failed to toggle member status");
      }
    }
  );

  app.delete(
    "/api/insurance/members/:id",
    requireAuth,
    validateRequest(memberActionInput),
    async (req: Request, res: Response) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
        const companyId = resolveRequestCompanyId(req);
        const [existing] = await db
          .select({ ledgerAccountId: insuranceMembers.ledgerAccountId })
          .from(insuranceMembers)
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)))
          .limit(1);
        if (!existing) return res.status(404).json({ message: "Member not found" });
        await db
          .delete(insuranceMembers)
          .where(and(eq(insuranceMembers.id, id), eq(insuranceMembers.companyId, companyId)));
        if (existing.ledgerAccountId) {
          // Only an account with no postings and no opening balance is removed:
          // deleting one that carries history drops its balance from every
          // report, and the ledger_accounts delete guard refuses it.
          await pool.query(
            `UPDATE ledger_accounts la SET deleted_at = NOW()
            WHERE la.id = $1 AND la.company_id = $2
              AND COALESCE(la.opening_balance, 0) = 0
              AND NOT EXISTS (
                SELECT 1 FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
                 WHERE ve.ledger_account_id = la.id AND v.deleted_at IS NULL
              )`,
            [existing.ledgerAccountId, companyId]
          );
        }
        res.json({ success: true });
      } catch (error: unknown) {
        logger.error("DELETE /api/insurance/members/:id error:", { error });
        sendRouteError(res, error, "Failed to delete insurance member");
      }
    }
  );

  app.get(
    "/api/insurance/import/template",
    privilegedReadRateLimit,
    requireAuth,
    async (_req: Request, res: Response) => {
      try {
        const buffer = await writeWorkbook(createInsuranceImportTemplate());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", 'attachment; filename="Insurance_Import_Template.xlsx"');
        res.setHeader("Cache-Control", "no-store, max-age=0");
        res.setHeader("Pragma", "no-cache");
        return res.send(buffer);
      } catch (error: unknown) {
        logger.error("GET /api/insurance/import/template error:", { error });
        return sendRouteError(res, error, "Failed to create Insurance import template");
      }
    }
  );

  app.post(
    "/api/insurance/import/preview",
    privilegedMutationRateLimit,
    requireAuth,
    spreadsheetUpload.single("file"),
    validateRequest(importPreviewInput),
    async (req: Request, res: Response) => {
      try {
        resolveRequestCompanyId(req);
        if (!req.file) return res.status(400).json({ message: "Choose an .xlsx workbook first" });
        if (!req.file.originalname.toLowerCase().endsWith(".xlsx")) {
          return res.status(400).json({ message: "Only .xlsx workbooks are supported" });
        }
        const defaultYear = Number(req.body?.year);
        if (!Number.isInteger(defaultYear) || defaultYear < 2000 || defaultYear > 2100) {
          return res.status(400).json({ message: "Choose a valid workbook year" });
        }
        const workbook = await readExcel(req.file.buffer);
        const preview = parseInsuranceWorkbook(workbook, defaultYear);
        return res.json(preview);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/import/preview error:", { error });
        sendRouteError(res, error, "Failed to read Insurance workbook");
      }
    }
  );
}
