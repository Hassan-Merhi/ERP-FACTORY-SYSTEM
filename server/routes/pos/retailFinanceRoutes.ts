import type { Express, Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ledgerAccounts, retailAccountMappings, retailCashierShifts, RETAIL_ACCOUNT_KEYS } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  closeRetailCashierShiftInTx,
  openRetailCashierShiftInTx,
  recordRetailCashMovementInTx,
} from "../../services/retail/retailShiftLifecycleService";
import { getRetailShiftReport } from "../../services/retail/retailShiftService";
import { getRetailReconciliationReport } from "../../services/retail/retailReconciliationService";
import { loadRetailAccountMappings } from "../../services/retail/retailAccountingBridge";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";

const idempotencyKeySchema = z.string().trim().min(8).max(191);
const openShiftSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  openingCash: z.coerce.number().finite().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
});
const cashMovementSchema = z.object({
  direction: z.enum(["cash_in", "cash_out"]),
  amount: z.coerce.number().finite().positive(),
  reason: z.string().trim().min(1).max(2000),
  idempotencyKey: idempotencyKeySchema,
});
const closeShiftSchema = z.object({
  actualCountedCash: z.coerce.number().finite().nonnegative(),
  notes: z.string().trim().max(2000).optional(),
});
const accountMappingSchema = z.object(
  Object.fromEntries(RETAIL_ACCOUNT_KEYS.map((key) => [key, z.coerce.number().int().positive()])) as Record<
    (typeof RETAIL_ACCOUNT_KEYS)[number],
    z.ZodNumber
  >
);
const accountMappingRequestSchema = z.object({ mappings: accountMappingSchema });

function isPOSUser(req: Request): boolean {
  return (req.session?.currentRole ?? req.user?.role) === "POS";
}

function assignedLocation(req: Request): number | null {
  const locationId = Number(req.user?.assignedLocationId ?? req.session?.currentLocationId ?? 0);
  return Number.isInteger(locationId) && locationId > 0 ? locationId : null;
}

function parseShiftId(raw: string): number | null {
  const shiftId = Number(raw);
  return Number.isInteger(shiftId) && shiftId > 0 ? shiftId : null;
}

export function registerRetailFinanceRoutes(app: Express): void {
  app.get("/api/pos/retail/shifts", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const posUser = isPOSUser(req);
      const requestedLocationId = Number(req.query.locationId ?? 0);
      const locationId = posUser ? assignedLocation(req) : requestedLocationId > 0 ? requestedLocationId : null;
      if (posUser && !locationId) return res.status(403).json({ message: "POS user has no assigned Retail location" });
      if (locationId) await ensureCompanyLocation(companyId, locationId, req);
      const ownOnly = posUser || String(req.query.mine ?? "") === "true";
      const shifts = await db
        .select()
        .from(retailCashierShifts)
        .where(
          and(
            eq(retailCashierShifts.companyId, companyId),
            locationId ? eq(retailCashierShifts.locationId, locationId) : undefined,
            ownOnly ? eq(retailCashierShifts.cashierId, currentUserId(req)) : undefined
          )
        )
        .orderBy(desc(retailCashierShifts.openedAt))
        .limit(Math.min(Math.max(Number(req.query.limit) || 100, 1), 500));
      res.json(shifts);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/shifts/open", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = openShiftSchema.parse(req.body);
      await ensureCompanyLocation(companyId, body.locationId, req);
      const userId = currentUserId(req);
      const result = await db.transaction((tx) =>
        openRetailCashierShiftInTx(tx, {
          companyId,
          locationId: body.locationId,
          cashierId: userId,
          openingCash: body.openingCash,
          idempotencyKey: body.idempotencyKey,
        })
      );
      const report = await getRetailShiftReport(companyId, result.shiftId);
      res.status(result.replayed ? 200 : 201).json({ ...result, shift: report?.shift ?? null, report });
    } catch (error) {
      const message = getErrorMessage(error);
      res.status(message.includes("already has an open") ? 409 : 400).json({ message });
    }
  });

  app.post("/api/pos/retail/shifts/:shiftId/cash-movements", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const shiftId = parseShiftId(req.params.shiftId);
      if (!shiftId) return res.status(400).json({ message: "Invalid shift" });
      const body = cashMovementSchema.parse(req.body);
      const userId = currentUserId(req);
      const [shift] = await db
        .select({ locationId: retailCashierShifts.locationId })
        .from(retailCashierShifts)
        .where(and(eq(retailCashierShifts.companyId, companyId), eq(retailCashierShifts.id, shiftId)))
        .limit(1);
      if (!shift) return res.status(404).json({ message: "Retail cashier shift not found" });
      await ensureCompanyLocation(companyId, shift.locationId, req);
      const result = await db.transaction((tx) =>
        recordRetailCashMovementInTx(tx, {
          companyId,
          locationId: shift.locationId,
          cashierId: userId,
          shiftId,
          direction: body.direction,
          amount: body.amount,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        })
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/retail/shifts/:shiftId/close", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const shiftId = parseShiftId(req.params.shiftId);
      if (!shiftId) return res.status(400).json({ message: "Invalid shift" });
      const body = closeShiftSchema.parse(req.body);
      const [shift] = await db
        .select({ locationId: retailCashierShifts.locationId })
        .from(retailCashierShifts)
        .where(and(eq(retailCashierShifts.companyId, companyId), eq(retailCashierShifts.id, shiftId)))
        .limit(1);
      if (!shift) return res.status(404).json({ message: "Retail cashier shift not found" });
      await ensureCompanyLocation(companyId, shift.locationId, req);
      const result = await db.transaction((tx) =>
        closeRetailCashierShiftInTx(tx, {
          companyId,
          shiftId,
          closingUserId: currentUserId(req),
          actualCountedCash: body.actualCountedCash,
          closeNotes: body.notes,
          mayCloseAnotherCashier: !isPOSUser(req),
        })
      );
      const report = await getRetailShiftReport(companyId, shiftId);
      res.status(200).json({ ...result, report });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pos/retail/shifts/:shiftId/report", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const shiftId = parseShiftId(req.params.shiftId);
      if (!shiftId) return res.status(400).json({ message: "Invalid shift" });
      const report = await getRetailShiftReport(companyId, shiftId);
      if (!report) return res.status(404).json({ message: "Retail cashier shift not found" });
      await ensureCompanyLocation(companyId, report.shift.locationId, req);
      if (isPOSUser(req) && report.shift.cashierId !== currentUserId(req)) {
        return res.status(403).json({ message: "POS users may only view their own cashier shift" });
      }
      res.json(report);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/finance/accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const [accounts, mappings] = await Promise.all([
        db
          .select({
            id: ledgerAccounts.id,
            code: ledgerAccounts.code,
            name: ledgerAccounts.name,
            accountType: ledgerAccounts.accountType,
            active: ledgerAccounts.active,
          })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.active, true)))
          .orderBy(ledgerAccounts.code),
        loadRetailAccountMappings(companyId),
      ]);
      const mapped = Object.fromEntries(mappings.map((row) => [row.accountKey, row.ledgerAccountId]));
      const missing = RETAIL_ACCOUNT_KEYS.filter((key) => !mapped[key]);
      res.json({
        accountKeys: RETAIL_ACCOUNT_KEYS,
        accounts,
        mappings: mapped,
        configured: missing.length === 0,
        missing,
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/retail/finance/accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const { mappings } = accountMappingRequestSchema.parse(req.body);
      const entries = Object.entries(mappings) as Array<[(typeof RETAIL_ACCOUNT_KEYS)[number], number]>;
      const accountIds = [...new Set(entries.map(([, accountId]) => accountId))];
      if (accountIds.length !== RETAIL_ACCOUNT_KEYS.length) {
        return res.status(400).json({ message: "Map each Retail account key to a different ledger account" });
      }
      const activeAccounts = await db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            eq(ledgerAccounts.active, true),
            inArray(ledgerAccounts.id, accountIds)
          )
        );
      if (activeAccounts.length !== RETAIL_ACCOUNT_KEYS.length) {
        return res
          .status(400)
          .json({ message: "Every mapped ledger account must be active and belong to this company" });
      }
      const userId = currentUserId(req);
      await db.transaction(async (tx) => {
        for (const [accountKey, ledgerAccountId] of entries) {
          await tx
            .insert(retailAccountMappings)
            .values({ companyId, accountKey, ledgerAccountId, updatedBy: userId })
            .onConflictDoUpdate({
              target: [retailAccountMappings.companyId, retailAccountMappings.accountKey],
              set: { ledgerAccountId, updatedBy: userId, updatedAt: new Date() },
            });
        }
      });
      const saved = await loadRetailAccountMappings(companyId);
      res.json({ configured: true, mappings: Object.fromEntries(saved.map((row) => [row.accountKey, row])) });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/finance/reconciliation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = req.query.locationId == null ? undefined : Number(req.query.locationId);
      if (locationId != null && (!Number.isInteger(locationId) || locationId <= 0)) {
        return res.status(400).json({ message: "Invalid Retail location" });
      }
      if (locationId) await ensureCompanyLocation(companyId, locationId, req);
      const report = await getRetailReconciliationReport({
        companyId,
        locationId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(report);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
