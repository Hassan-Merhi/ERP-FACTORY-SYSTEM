// Extracted from ./registerFactoryInsuranceRoutesPart1.ts
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { and, desc, eq } from "drizzle-orm";
import { db, pool } from "../../db";
import { requireAuth } from "../../auth";
import {
  insertInsuranceMemberSchema,
  insuranceMembers,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { findOrCreateLedger, sendRouteError } from "./factoryInsuranceRoutesHelpers";

export function registerFactoryInsuranceRoutesPart3(app: Express) {
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
  });
}
