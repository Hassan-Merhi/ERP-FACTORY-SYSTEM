import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import {
  accountingPostingRequests,
  auditLog,
  insuranceMemberMonthlyAmounts,
  insuranceMembers,
  insertInsuranceMemberSchema,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { infrastructurePostingIdentity } from "../../services/accounting/infrastructureVoucherIdentity";
import { isCompanyIsolationError, resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import {
  privilegedDestructiveRateLimit,
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
} from "../../middleware/privilegedEndpointSecurity";
import { upload } from "../_helpers";
import { readExcel, writeWorkbook } from "../../excelHelper";
import {
  createInsuranceImportTemplate,
  parseInsuranceWorkbook,
  type InsuranceImportRow,
} from "../../services/factory/insuranceWorkbookImport";

const CLEAR_CONFIRMATION = "CLEAR ALL INSURANCE";

const insuranceImportApplySchema = z.object({
  rows: z
    .array(
      z.object({
        sheetName: z.string().min(1).max(100),
        monthStart: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/),
        name: z.string().trim().min(1).max(500),
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        nationality: z.string().max(500).optional(),
        positionWorking: z.string().max(500).optional(),
        insuranceNumber: z.string().max(500).optional(),
        dob: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().max(5000).optional(),
      })
    )
    .min(1)
    .max(10_000),
});

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sendRouteError(res: import("express").Response, error: unknown, fallback: string): void {
  if (isCompanyIsolationError(error)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  res.status(500).json({ message: errorMessage(error, fallback) });
}

async function findOrCreateLedger(companyId: number, name: string, accountType: string): Promise<{ id: number }> {
  const existing = await pool.query(
    `SELECT id FROM ledger_accounts WHERE company_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
    [companyId, name]
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id };

  const maxRow = await pool.query(
    `SELECT MAX(CAST(code AS INTEGER)) AS max_code
     FROM ledger_accounts
     WHERE company_id = $1 AND code ~ '^[0-9]+$'`,
    [companyId]
  );
  const nextCode = String((parseInt(maxRow.rows[0]?.max_code || "0") || 0) + 1);

  const inserted = await pool.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, active, is_hidden)
     VALUES ($1, $2, $3, $4, true, false)
     ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [companyId, nextCode, name, accountType]
  );
  return { id: inserted.rows[0].id };
}

async function findOrCreateLedgerTx(
  tx: DbTransaction,
  companyId: number,
  name: string,
  accountType: string
): Promise<{ id: number }> {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    )
    .limit(1);
  if (existing) return existing;

  const [maxRow] = await tx
    .select({
      maxCode: sql<string>`MAX(CASE WHEN ${ledgerAccounts.code} ~ '^[0-9]+$' THEN CAST(${ledgerAccounts.code} AS INTEGER) ELSE 0 END)`,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.companyId, companyId));
  let nextCode = (Number(maxRow?.maxCode ?? 0) || 0) + 1;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [inserted] = await tx
      .insert(ledgerAccounts)
      .values({
        companyId,
        code: String(nextCode),
        name,
        accountType,
        active: true,
        isHidden: false,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerAccounts.id });
    if (inserted) return inserted;
    nextCode += 1;
  }
  throw new Error(`Could not allocate a ledger code for ${name}`);
}

function normalizedMemberName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function registerFactoryInsuranceRoutes(app: Express) {
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

  app.post("/api/insurance/members", requireAuth, async (req: Request, res: Response) => {
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
  });

  app.patch("/api/insurance/members/:id", requireAuth, async (req: Request, res: Response) => {
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
  });

  app.patch("/api/insurance/members/:id/toggle", requireAuth, async (req: Request, res: Response) => {
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
  });

  app.delete("/api/insurance/members/:id", requireAuth, async (req: Request, res: Response) => {
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
        await pool.query(`UPDATE ledger_accounts SET deleted_at = NOW() WHERE id = $1 AND company_id = $2`, [
          existing.ledgerAccountId,
          companyId,
        ]);
      }
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("DELETE /api/insurance/members/:id error:", { error });
      sendRouteError(res, error, "Failed to delete insurance member");
    }
  });

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
    upload.single("file"),
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

  app.post(
    "/api/insurance/import/apply",
    privilegedMutationRateLimit,
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const parsed = insuranceImportApplySchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ message: "Invalid import data", errors: parsed.error.issues });
        }
        const companyId = resolveRequestCompanyId(req);
        const rows = parsed.data.rows as InsuranceImportRow[];
        const duplicateKeys = new Set<string>();
        for (const row of rows) {
          const key = `${row.monthStart}:${normalizedMemberName(row.name)}`;
          if (duplicateKeys.has(key)) {
            return res.status(400).json({ message: `Duplicate member ${row.name} for ${row.monthStart}` });
          }
          duplicateKeys.add(key);
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"insurance-import:" + companyId}))`);
          const existingRows = await tx
            .select()
            .from(insuranceMembers)
            .where(eq(insuranceMembers.companyId, companyId));
          const existingByName = new Map<string, typeof existingRows>();
          for (const member of existingRows) {
            const key = normalizedMemberName(member.name);
            existingByName.set(key, [...(existingByName.get(key) ?? []), member]);
          }
          for (const [name, matches] of existingByName) {
            if (matches.length > 1) {
              throw new Error(
                `Existing Insurance data has duplicate member name "${name}". Resolve it before importing.`
              );
            }
          }

          const rowsByMember = new Map<string, InsuranceImportRow[]>();
          for (const row of rows) {
            const key = normalizedMemberName(row.name);
            rowsByMember.set(key, [...(rowsByMember.get(key) ?? []), row]);
          }

          let createdMembers = 0;
          let updatedMembers = 0;
          let monthlyAmountsUpserted = 0;
          for (const [memberKey, memberRows] of rowsByMember) {
            memberRows.sort((a, b) => a.monthStart.localeCompare(b.monthStart));
            let member = existingByName.get(memberKey)?.[0];
            if (!member) {
              const firstRow = memberRows[0];
              const earliestStartDate = memberRows.reduce(
                (earliest, row) => (row.startDate < earliest ? row.startDate : earliest),
                firstRow.startDate
              );
              const ledger = await findOrCreateLedgerTx(tx, companyId, `Insurance - ${firstRow.name}`, "Liability");
              const [inserted] = await tx
                .insert(insuranceMembers)
                .values({
                  companyId,
                  name: firstRow.name,
                  nationality: firstRow.nationality ?? null,
                  positionWorking: firstRow.positionWorking ?? null,
                  insuranceNumber: firstRow.insuranceNumber ?? null,
                  startDate: earliestStartDate,
                  amount: memberRows[memberRows.length - 1].amount,
                  dob: firstRow.dob ?? null,
                  notes: firstRow.notes ?? null,
                  active: true,
                  ledgerAccountId: ledger.id,
                })
                .returning();
              if (!inserted) throw new Error(`Failed to create Insurance member ${firstRow.name}`);
              member = inserted;
              existingByName.set(memberKey, [member]);
              createdMembers += 1;
            } else {
              updatedMembers += 1;
            }

            for (const row of memberRows) {
              await tx
                .insert(insuranceMemberMonthlyAmounts)
                .values({
                  companyId,
                  memberId: member.id,
                  monthStart: row.monthStart,
                  amount: row.amount,
                })
                .onConflictDoUpdate({
                  target: [
                    insuranceMemberMonthlyAmounts.companyId,
                    insuranceMemberMonthlyAmounts.memberId,
                    insuranceMemberMonthlyAmounts.monthStart,
                  ],
                  set: { amount: row.amount, updatedAt: new Date() },
                });
              monthlyAmountsUpserted += 1;
            }

            const [latestAmount] = await tx
              .select({ amount: insuranceMemberMonthlyAmounts.amount })
              .from(insuranceMemberMonthlyAmounts)
              .where(
                and(
                  eq(insuranceMemberMonthlyAmounts.companyId, companyId),
                  eq(insuranceMemberMonthlyAmounts.memberId, member.id)
                )
              )
              .orderBy(desc(insuranceMemberMonthlyAmounts.monthStart))
              .limit(1);
            if (latestAmount) {
              await tx
                .update(insuranceMembers)
                .set({ amount: latestAmount.amount })
                .where(and(eq(insuranceMembers.companyId, companyId), eq(insuranceMembers.id, member.id)));
            }
          }

          await tx.insert(auditLog).values({
            userId: String(req.session.userId ?? "system"),
            username: req.session.username ?? "unknown",
            companyId,
            action: "import",
            tableName: "insurance_members",
            recordIdentifier: "multi-sheet-excel-import",
            changes: {
              createdMembers: { old: null, new: createdMembers },
              updatedMembers: { old: null, new: updatedMembers },
              monthlyAmountsUpserted: { old: null, new: monthlyAmountsUpserted },
            },
          });
          return { createdMembers, updatedMembers, monthlyAmountsUpserted };
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/import/apply error:", { error });
        sendRouteError(res, error, "Failed to import Insurance workbook");
      }
    }
  );

  app.post(
    "/api/insurance/admin/clear-all",
    privilegedDestructiveRateLimit,
    requireAuth,
    requireRole("Admin", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        if (req.body?.confirmation !== CLEAR_CONFIRMATION) {
          return res.status(400).json({
            message: `Type ${CLEAR_CONFIRMATION} to confirm`,
            confirmationRequired: CLEAR_CONFIRMATION,
          });
        }

        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"insurance-clear:" + companyId}))`);
          const members = await tx
            .select({ id: insuranceMembers.id, ledgerAccountId: insuranceMembers.ledgerAccountId })
            .from(insuranceMembers)
            .where(eq(insuranceMembers.companyId, companyId));
          const insuranceAccounts = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                or(eq(ledgerAccounts.name, "Insurance Expense"), ilike(ledgerAccounts.name, "Insurance - %"))
              )
            );
          const insuranceVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                ilike(vouchers.voucherNumber, "INS-%"),
                or(eq(vouchers.sourceModule, "ERP"), isNull(vouchers.sourceModule))
              )
            );
          const voucherIds = insuranceVouchers.map((voucher) => voucher.id);
          const accountIds = Array.from(
            new Set([
              ...insuranceAccounts.map((account) => account.id),
              ...members.map((member) => member.ledgerAccountId).filter((id): id is number => typeof id === "number"),
            ])
          );

          if (voucherIds.length > 0) {
            await tx.delete(accountingPostingRequests).where(inArray(accountingPostingRequests.voucherId, voucherIds));
            await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, voucherIds));
            await tx.delete(vouchers).where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, voucherIds)));
          }
          await tx.delete(insuranceMemberMonthlyAmounts).where(eq(insuranceMemberMonthlyAmounts.companyId, companyId));
          await tx.delete(insuranceMembers).where(eq(insuranceMembers.companyId, companyId));
          if (accountIds.length > 0) {
            await tx
              .update(ledgerAccounts)
              .set({ deletedAt: new Date(), active: false })
              .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, accountIds)));
          }

          await tx.insert(auditLog).values({
            userId: String(req.session.userId ?? "system"),
            username: req.session.username ?? "unknown",
            companyId,
            action: "delete",
            tableName: "insurance_reset",
            recordIdentifier: CLEAR_CONFIRMATION,
            changes: {
              membersDeleted: { old: members.length, new: 0 },
              vouchersDeleted: { old: voucherIds.length, new: 0 },
              ledgerAccountsArchived: { old: accountIds.length, new: 0 },
            },
          });
          return {
            membersDeleted: members.length,
            vouchersDeleted: voucherIds.length,
            voucherEntriesDeleted: true,
            monthlyAmountsDeleted: true,
            ledgerAccountsArchived: accountIds.length,
          };
        });

        logger.warn("Insurance records cleared", {
          companyId,
          userId: req.session.userId ?? null,
          ...result,
        });
        return res.json(result);
      } catch (error: unknown) {
        logger.error("POST /api/insurance/admin/clear-all error:", { error });
        sendRouteError(res, error, "Failed to clear Insurance records");
      }
    }
  );

  app.post("/api/insurance/generate", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = z
        .object({ month: z.number().min(1).max(12), year: z.number().min(2000).max(2100) })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Validation failed", errors: parsed.error.issues });
      }
      const { month, year } = parsed.data;
      const companyId = resolveRequestCompanyId(req);
      const periodStart = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const periodEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const members = await db
        .select({
          id: insuranceMembers.id,
          name: insuranceMembers.name,
          startDate: insuranceMembers.startDate,
          amount: insuranceMembers.amount,
          ledgerAccountId: insuranceMembers.ledgerAccountId,
        })
        .from(insuranceMembers)
        .where(and(eq(insuranceMembers.companyId, companyId), eq(insuranceMembers.active, true)));
      const monthlyAmounts = await db
        .select({
          memberId: insuranceMemberMonthlyAmounts.memberId,
          amount: insuranceMemberMonthlyAmounts.amount,
        })
        .from(insuranceMemberMonthlyAmounts)
        .where(
          and(
            eq(insuranceMemberMonthlyAmounts.companyId, companyId),
            eq(insuranceMemberMonthlyAmounts.monthStart, periodStart)
          )
        );
      const monthlyAmountByMember = new Map(monthlyAmounts.map((row) => [row.memberId, row.amount]));
      const eligibleMembers = members.filter((member) => member.startDate <= periodEnd);
      if (eligibleMembers.length === 0) {
        return res.status(400).json({ message: "No active insurance members found for this period" });
      }

      const expenseAccount = await findOrCreateLedger(companyId, "Insurance Expense", "Expense");
      const memberLedgers: { ledgerId: number; amount: number }[] = [];
      for (const member of eligibleMembers) {
        let ledgerId = member.ledgerAccountId;
        if (!ledgerId) {
          const ledger = await findOrCreateLedger(companyId, `Insurance - ${member.name}`, "Liability");
          ledgerId = ledger.id;
          await db
            .update(insuranceMembers)
            .set({ ledgerAccountId: ledgerId })
            .where(and(eq(insuranceMembers.id, member.id), eq(insuranceMembers.companyId, companyId)));
        }
        let memberAmount = parseFloat(monthlyAmountByMember.get(member.id) ?? member.amount);
        if (member.startDate > periodStart && member.startDate <= periodEnd) {
          const startDay = parseInt(member.startDate.split("-")[2]);
          memberAmount = parseFloat(((memberAmount / lastDay) * (lastDay - startDay + 1)).toFixed(2));
        }
        memberLedgers.push({ ledgerId, amount: memberAmount });
      }

      const totalAmount = memberLedgers.reduce((sum, member) => sum + member.amount, 0);
      const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", {
        month: "long",
        year: "numeric",
      });
      const voucherNumber = `INS-${year}-${String(month).padStart(2, "0")}`;
      const narration = `Insurance entries for ${monthLabel}`;
      const result = await db.transaction((tx) =>
        postBalancedVoucherTx(
          tx,
          {
            voucher: {
              companyId,
              voucherNumber,
              voucherType: "Journal",
              description: narration,
              voucherDate: periodStart,
              totalAmount: totalAmount.toFixed(2),
              sourceModule: "ERP",
            },
            entries: [
              {
                ledgerAccountId: expenseAccount.id,
                debitAmount: "0",
                creditAmount: totalAmount.toFixed(2),
                narration,
              },
              ...memberLedgers.map((member) => ({
                ledgerAccountId: member.ledgerId,
                debitAmount: member.amount.toFixed(2),
                creditAmount: "0",
                narration,
              })),
            ],
            source: infrastructurePostingIdentity(
              "factory-insurance",
              `${companyId}:${year}:${String(month).padStart(2, "0")}`,
              "monthly-journal"
            ),
            actor: {
              userId: req.user?.id ?? null,
              username: req.user?.username ?? null,
              reason: "Generate monthly insurance journal",
            },
          },
          createDatabasePostingDependencies()
        )
      );

      const postedVoucher = result.voucher as { id: number; voucherNumber: string };
      res.json({
        voucherId: postedVoucher.id,
        voucherNumber: postedVoucher.voucherNumber,
        totalAmount,
        membersCount: eligibleMembers.length,
        period: monthLabel,
      });
    } catch (error: unknown) {
      logger.error("POST /api/insurance/generate error:", { error });
      sendRouteError(res, error, "Failed to generate insurance entries");
    }
  });
}
