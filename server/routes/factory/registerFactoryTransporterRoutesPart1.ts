// Extracted from ./factoryTransporterRoutes.ts
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { factoryTransporters, factoryTransporterTransactions } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { factorySessionActor, postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { PostingValidationError } from "../../services/accounting/postingValidationError";

export function getCompanyId(req: Request): number | null {
  const s = req.session;
  return s?.factoryCompanyId || s?.currentCompanyId || null;
}

export function registerFactoryTransporterRoutesPart1(app: Express) {
  // ── UPDATE transporter ──
  app.patch("/api/factory/transporters/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const { name, phone, notes } = z
        .object({
          name: z.string().min(1).optional(),
          phone: z.string().optional(),
          notes: z.string().optional(),
        })
        .parse(req.body);

      // Every field is optional, so a body with none of them reached drizzle as
      // .set({}) — which throws "No values to set" and surfaced as a 500.
      const updates = {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(notes !== undefined && { notes }),
      };
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No fields to update" });
      }

      const [updated] = await db
        .update(factoryTransporters)
        .set(updates)
        .where(and(eq(factoryTransporters.id, id), eq(factoryTransporters.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Transporter not found" });
      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── RECORD CHARGE (Dr Expense / Cr Transporter Account) ──
  app.post("/api/factory/transporters/:id/charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transporterId = parseId(req.params.id);
      if (transporterId === null) return res.status(400).json({ message: "Invalid id" });

      const { amount, txDate, description, expenseAccountId } = z
        .object({
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          txDate: z.string().min(1),
          description: z.string().optional(),
          expenseAccountId: z.number(),
        })
        .parse(req.body);

      const [transporter] = await db
        .select()
        .from(factoryTransporters)
        .where(and(eq(factoryTransporters.id, transporterId), eq(factoryTransporters.companyId, companyId)));
      if (!transporter) return res.status(404).json({ message: "Transporter not found" });

      const narration = description || `Transport charge - ${transporter.name}`;
      const postedAmount = (parseMoneyInput(amount) ?? toMoney(0)).toDecimalPlaces(2);
      if (postedAmount.lessThanOrEqualTo(0))
        return res.status(400).json({ message: "Amount must be a positive number" });

      const tx = await db.transaction(async (trx) => {
        // Phase 22 (C): the transaction row first, then its voucher through the
        // engine (engine-numbered — was TRANS-CHG-{Date.now()}, which the
        // container offload readers could mistake for a TRANS- offload voucher —
        // with the row's posting identity), then the link.
        const [record] = await trx
          .insert(factoryTransporterTransactions)
          .values({
            companyId,
            transporterId,
            txType: "charge",
            amount: postedAmount.toFixed(2),
            txDate: txDate,
            description: narration,
            expenseAccountId,
          })
          .returning();
        const { voucher: v } = await postFactoryVoucherTx(trx, {
          companyId,
          voucherType: "Payment",
          voucherDate: txDate,
          description: narration,
          sourceModule: "ERP",
          source: { sourceType: "factory-transporter-charge", sourceId: record.id, phase: "voucher" },
          actor: factorySessionActor(req),
          lines: [
            { ledgerAccountId: expenseAccountId, debit: postedAmount, narration },
            { ledgerAccountId: transporter.ledgerAccountId!, credit: postedAmount, narration },
          ],
        });
        const [linked] = await trx
          .update(factoryTransporterTransactions)
          .set({ voucherId: v.id })
          .where(eq(factoryTransporterTransactions.id, record.id))
          .returning();
        return linked;
      });

      res.json(tx);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      if (e instanceof PostingValidationError) return res.status(400).json({ message: e.message, code: e.code });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── RECORD PAYMENT (Dr Transporter Account / Cr Cash) ──
  app.post("/api/factory/transporters/:id/payments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transporterId = parseId(req.params.id);
      if (transporterId === null) return res.status(400).json({ message: "Invalid id" });

      const { amount, txDate, description, cashAccountId } = z
        .object({
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
          txDate: z.string().min(1),
          description: z.string().optional(),
          cashAccountId: z.number(),
        })
        .parse(req.body);

      const [transporter] = await db
        .select()
        .from(factoryTransporters)
        .where(and(eq(factoryTransporters.id, transporterId), eq(factoryTransporters.companyId, companyId)));
      if (!transporter) return res.status(404).json({ message: "Transporter not found" });

      const narration = description || `Payment to transporter - ${transporter.name}`;
      const postedAmount = (parseMoneyInput(amount) ?? toMoney(0)).toDecimalPlaces(2);
      if (postedAmount.lessThanOrEqualTo(0))
        return res.status(400).json({ message: "Amount must be a positive number" });

      const tx = await db.transaction(async (trx) => {
        // Phase 22 (C): the transaction row first, then its voucher through the
        // engine (engine-numbered — was TRANS-PAY-{Date.now()}, which the
        // container offload readers could mistake for a TRANS- offload voucher —
        // with the row's posting identity), then the link.
        const [record] = await trx
          .insert(factoryTransporterTransactions)
          .values({
            companyId,
            transporterId,
            txType: "payment",
            amount: postedAmount.toFixed(2),
            txDate: txDate,
            description: narration,
            cashAccountId,
          })
          .returning();
        const { voucher: v } = await postFactoryVoucherTx(trx, {
          companyId,
          voucherType: "Payment",
          voucherDate: txDate,
          description: narration,
          sourceModule: "ERP",
          source: { sourceType: "factory-transporter-payment", sourceId: record.id, phase: "voucher" },
          actor: factorySessionActor(req),
          lines: [
            { ledgerAccountId: transporter.ledgerAccountId!, debit: postedAmount, narration },
            { ledgerAccountId: cashAccountId, credit: postedAmount, narration },
          ],
        });
        const [linked] = await trx
          .update(factoryTransporterTransactions)
          .set({ voucherId: v.id })
          .where(eq(factoryTransporterTransactions.id, record.id))
          .returning();
        return linked;
      });

      res.json(tx);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      if (e instanceof PostingValidationError) return res.status(400).json({ message: e.message, code: e.code });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
