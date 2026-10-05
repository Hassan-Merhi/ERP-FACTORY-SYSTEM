import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bankAccounts,
  ledgerAccounts,
  posShifts,
  retailCashMovements,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./pos/retailPosContext";
import {
  getRetailAccountingSettings,
  getRetailFinancialReconciliation,
  getRetailShiftSummary,
  listRetailFinancialAccounts,
  saveRetailAccountingSettings,
} from "../services/retail/retailFinancialService";

const nullableId = z.union([z.coerce.number().int().positive(), z.null()]).optional();

const settingsSchema = z.object({
  locationId: nullableId,
  cashLedgerAccountId: nullableId,
  cardLedgerAccountId: nullableId,
  bankLedgerAccountId: nullableId,
  bankAccountId: nullableId,
  mobileLedgerAccountId: nullableId,
  otherLedgerAccountId: nullableId,
  salesRevenueLedgerAccountId: nullableId,
  inventoryAssetLedgerAccountId: nullableId,
  cogsLedgerAccountId: nullableId,
  discountsLedgerAccountId: nullableId,
  taxPayableLedgerAccountId: nullableId,
  storeCreditLedgerAccountId: nullableId,
});

const cashMovementSchema = z.object({
  movementType: z.enum(["cash_in", "cash_out"]),
  amount: z.coerce.number().finite().positive().max(1000000000),
  reason: z.string().trim().min(2).max(500),
  idempotencyKey: z.string().trim().min(8).max(191),
});

async function assertAccountOwnership(
  companyId: number,
  patch: z.infer<typeof settingsSchema>
): Promise<void> {
  const ledgerIds = [
    patch.cashLedgerAccountId,
    patch.cardLedgerAccountId,
    patch.bankLedgerAccountId,
    patch.mobileLedgerAccountId,
    patch.otherLedgerAccountId,
    patch.salesRevenueLedgerAccountId,
    patch.inventoryAssetLedgerAccountId,
    patch.cogsLedgerAccountId,
    patch.discountsLedgerAccountId,
    patch.taxPayableLedgerAccountId,
    patch.storeCreditLedgerAccountId,
  ].filter((value): value is number => typeof value === "number");

  if (ledgerIds.length) {
    const owned = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, [...new Set(ledgerIds)])));
    if (owned.length !== new Set(ledgerIds).size) throw new Error("One or more Retail ledger accounts belong to another company");
  }
  if (typeof patch.bankAccountId === "number") {
    const [bank] = await db
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, patch.bankAccountId)))
      .limit(1);
    if (!bank) throw new Error("Retail bank account belongs to another company");
  }
  if (typeof patch.locationId === "number") await ensureCompanyLocation(companyId, patch.locationId);
}

async function loadAuthorizedShift(
  companyId: number,
  shiftId: number,
  user: { id?: string | null; role?: string | null } | undefined
) {
  const [shift] = await db
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.id, shiftId), eq(posShifts.companyId, companyId)))
    .limit(1);
  if (!shift) throw new Error("Shift not found");
  if (user?.role === "POS" && shift.userId !== user.id) throw new Error("You can only access your own shift");
  return shift;
}

export function registerRetailFinancialRoutes(app: Express): void {
  app.get("/api/retail/financial/accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      res.json(await listRetailFinancialAccounts(companyId));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/financial/settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const scopedLocation = Number.isInteger(locationId) && locationId > 0 ? locationId : null;
      if (scopedLocation) await ensureCompanyLocation(companyId, scopedLocation);
      res.json(await getRetailAccountingSettings(companyId, scopedLocation));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/retail/financial/settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const parsed = settingsSchema.parse(req.body);
      await assertAccountOwnership(companyId, parsed);
      const { locationId = null, ...patch } = parsed;
      res.json(await saveRetailAccountingSettings(companyId, locationId ?? null, patch));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/financial/reconciliation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      const scopedLocation = Number.isInteger(locationId) && locationId > 0 ? locationId : null;
      if (scopedLocation) await ensureCompanyLocation(companyId, scopedLocation);
      const parseDate = (raw: unknown): Date | null => {
        if (!raw) return null;
        const date = new Date(String(raw));
        if (Number.isNaN(date.getTime())) throw new Error("Invalid reconciliation date");
        return date;
      };
      res.json(
        await getRetailFinancialReconciliation(companyId, {
          locationId: scopedLocation,
          from: parseDate(req.query.from),
          to: parseDate(req.query.to),
        })
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/retail/shifts/:id/summary", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ message: "Invalid shift" });
      await loadAuthorizedShift(companyId, shiftId, req.user);
      res.json(await getRetailShiftSummary(companyId, shiftId));
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("only access") ? 403 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/shifts/:id/cash-movements", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) return res.status(400).json({ message: "Invalid shift" });
      const shift = await loadAuthorizedShift(companyId, shiftId, req.user);
      if (shift.status !== "open") return res.status(409).json({ message: "Shift is already closed" });
      const body = cashMovementSchema.parse(req.body);
      const userId = currentUserId(req);

      const [created] = await db
        .insert(retailCashMovements)
        .values({
          companyId,
          locationId: shift.locationId,
          shiftId,
          movementType: body.movementType,
          amount: body.amount.toFixed(6),
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
          createdBy: userId,
        })
        .onConflictDoNothing({ target: [retailCashMovements.companyId, retailCashMovements.idempotencyKey] })
        .returning();

      const row =
        created ??
        (
          await db
            .select()
            .from(retailCashMovements)
            .where(
              and(
                eq(retailCashMovements.companyId, companyId),
                eq(retailCashMovements.idempotencyKey, body.idempotencyKey)
              )
            )
            .limit(1)
        )[0];
      if (!row) throw new Error("Cash movement retry could not be resolved");
      if (
        !created &&
        (row.shiftId !== shiftId ||
          row.movementType !== body.movementType ||
          Math.abs(Number(row.amount) - body.amount) > 0.000001 ||
          row.reason !== body.reason)
      ) {
        return res.status(409).json({ message: "Cash movement idempotency key was reused with different data" });
      }
      res.status(created ? 201 : 200).json({
        replayed: !created,
        movement: row,
        summary: await getRetailShiftSummary(companyId, shiftId),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("only access") ? 403 : 400).json({ message });
    }
  });
}
