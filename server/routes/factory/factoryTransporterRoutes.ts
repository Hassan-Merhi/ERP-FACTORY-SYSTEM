import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { getOrCreateLedgerAccount } from "./_helpers";
import {
  factoryTransporters,
  factoryTransporterTransactions,
  ledgerAccounts,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import { z } from "zod";

function getCompanyId(req: Request): number | null {
  const s = req.session;
  return s?.factoryCompanyId || s?.currentCompanyId || null;
}

export function registerFactoryTransporterRoutes(app: Express) {
  // ── LIST all transporters (with balance summary) ──
  app.get("/api/factory/transporters", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const transporters = await db
        .select()
        .from(factoryTransporters)
        .where(and(eq(factoryTransporters.companyId, companyId), eq(factoryTransporters.active, true)))
        .orderBy(asc(factoryTransporters.name));

      const ids = transporters.map((t) => t.id);
      const balances: Record<number, { charged: number; paid: number }> = {};
      if (ids.length > 0) {
        const rows = await db
          .select({
            transporterId: factoryTransporterTransactions.transporterId,
            txType: factoryTransporterTransactions.txType,
            total: sql<string>`COALESCE(SUM(${factoryTransporterTransactions.amount}), 0)`,
          })
          .from(factoryTransporterTransactions)
          .where(eq(factoryTransporterTransactions.companyId, companyId))
          .groupBy(factoryTransporterTransactions.transporterId, factoryTransporterTransactions.txType);

        rows.forEach((r) => {
          if (!balances[r.transporterId]) balances[r.transporterId] = { charged: 0, paid: 0 };
          if (r.txType === "charge") balances[r.transporterId].charged += Number(r.total);
          else balances[r.transporterId].paid += Number(r.total);
        });
      }

      res.json(
        transporters.map((t) => ({
          ...t,
          totalCharged: balances[t.id]?.charged ?? 0,
          totalPaid: balances[t.id]?.paid ?? 0,
          outstanding: (balances[t.id]?.charged ?? 0) - (balances[t.id]?.paid ?? 0),
        }))
      );
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GET single transporter with full statement ──
  app.get("/api/factory/transporters/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [transporter] = await db
        .select()
        .from(factoryTransporters)
        .where(and(eq(factoryTransporters.id, id), eq(factoryTransporters.companyId, companyId)));
      if (!transporter) return res.status(404).json({ message: "Transporter not found" });

      const transactions = await db
        .select()
        .from(factoryTransporterTransactions)
        .where(
          and(
            eq(factoryTransporterTransactions.transporterId, id),
            eq(factoryTransporterTransactions.companyId, companyId)
          )
        )
        .orderBy(asc(factoryTransporterTransactions.txDate), asc(factoryTransporterTransactions.id));

      let runningBalance = 0;
      const withBalance = transactions.map((tx) => {
        if (tx.txType === "charge") runningBalance += Number(tx.amount);
        else runningBalance -= Number(tx.amount);
        return { ...tx, runningBalance };
      });

      const totalCharged = transactions.filter((t) => t.txType === "charge").reduce((s, t) => s + Number(t.amount), 0);
      const totalPaid = transactions.filter((t) => t.txType === "payment").reduce((s, t) => s + Number(t.amount), 0);

      res.json({
        ...transporter,
        transactions: withBalance,
        totalCharged,
        totalPaid,
        outstanding: totalCharged - totalPaid,
      });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── CREATE transporter ──
  app.post("/api/factory/transporters", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { name, phone, notes } = z
        .object({
          name: z.string().min(1),
          phone: z.string().optional(),
          notes: z.string().optional(),
        })
        .parse(req.body);

      const code = `TRANS-${name
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "-")
        .slice(0, 30)}`;
      const ledgerAccountId = await getOrCreateLedgerAccount(companyId, code, name, "Transporter Agent");

      const [created] = await db
        .insert(factoryTransporters)
        .values({
          companyId,
          name,
          phone,
          notes,
          ledgerAccountId,
          active: true,
        })
        .returning();

      res.json(created);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

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

      const tx = await db.transaction(async (trx) => {
        const [v] = await trx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber: `TRANS-CHG-${Date.now()}-${transporterId}`,
            voucherType: "Payment",
            voucherDate: txDate,
            description: narration,
            totalAmount: amount,
            currency: "USD",
            sourceModule: "ERP",
          })
          .returning();

        await trx.insert(voucherEntries).values([
          { voucherId: v.id, ledgerAccountId: expenseAccountId, debitAmount: amount, creditAmount: "0", narration },
          {
            voucherId: v.id,
            ledgerAccountId: transporter.ledgerAccountId!,
            debitAmount: "0",
            creditAmount: amount,
            narration,
          },
        ]);

        const [record] = await trx
          .insert(factoryTransporterTransactions)
          .values({
            companyId,
            transporterId,
            txType: "charge",
            amount,
            txDate: txDate,
            description: narration,
            expenseAccountId,
            voucherId: v.id,
          })
          .returning();

        return record;
      });

      res.json(tx);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
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

      const tx = await db.transaction(async (trx) => {
        const [v] = await trx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber: `TRANS-PAY-${Date.now()}-${transporterId}`,
            voucherType: "Payment",
            voucherDate: txDate,
            description: narration,
            totalAmount: amount,
            currency: "USD",
            sourceModule: "ERP",
          })
          .returning();

        await trx.insert(voucherEntries).values([
          {
            voucherId: v.id,
            ledgerAccountId: transporter.ledgerAccountId!,
            debitAmount: amount,
            creditAmount: "0",
            narration,
          },
          { voucherId: v.id, ledgerAccountId: cashAccountId, debitAmount: "0", creditAmount: amount, narration },
        ]);

        const [record] = await trx
          .insert(factoryTransporterTransactions)
          .values({
            companyId,
            transporterId,
            txType: "payment",
            amount,
            txDate: txDate,
            description: narration,
            cashAccountId,
            voucherId: v.id,
          })
          .returning();

        return record;
      });

      res.json(tx);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── DELETE a transaction ──
  app.delete("/api/factory/transporters/:id/transactions/:txId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const txId = parseId(req.params.txId);
      if (txId === null) return res.status(400).json({ message: "Invalid id" });

      const [tx] = await db
        .select()
        .from(factoryTransporterTransactions)
        .where(
          and(eq(factoryTransporterTransactions.id, txId), eq(factoryTransporterTransactions.companyId, companyId))
        );
      if (!tx) return res.status(404).json({ message: "Transaction not found" });

      await db.transaction(async (trx) => {
        // The transaction row has to go first. factory_transporter_transactions
        // .voucher_id references vouchers.id with ON DELETE RESTRICT, so
        // deleting the voucher while this row still points at it raises 23503
        // and the whole request fails — which it did for every transaction that
        // had a voucher, meaning all of them.
        await trx.delete(factoryTransporterTransactions).where(eq(factoryTransporterTransactions.id, txId));
        if (tx.voucherId) {
          await trx.delete(voucherEntries).where(eq(voucherEntries.voucherId, tx.voucherId));
          await trx.delete(vouchers).where(eq(vouchers.id, tx.voucherId));
        }
      });

      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── GET cash/expense accounts for forms ──
  app.get("/api/factory/transporter-accounts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const accounts = await db
        .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.active, true)))
        .orderBy(asc(ledgerAccounts.name));

      res.json(accounts);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
