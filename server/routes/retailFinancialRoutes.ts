import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts, ledgerAccounts, posShifts, retailCashMovements } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage, HttpError } from "../lib/httpHandlers";
import { closedPeriodErrorResponse } from "../lib/closedPeriodError";
import {
  RETAIL_CASH_AMOUNT_CENTS_MESSAGE,
  RETAIL_CASH_REASON_CODE,
  RetailCashReasonUnmappedError,
  assertRetailCashReasonPostableTx,
  isCashAmountInCents,
  postRetailCashMovementTx,
} from "../services/retail/retailCashJournal";
import { registerRetailLedgerRoutes } from "./retailLedgerRoutes";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./pos/retailPosContext";
import {
  getRetailAccountingSettings,
  RetailAccountConflictError,
  saveRetailAccountingSettings,
} from "../services/retail/retailFinancialService";
import { writeAuditEvent } from "../services/audit";
import { parseMoneyInput, toMoney } from "../lib/money";
import {
  getRetailFinancialReconciliation,
  getRetailShiftSummary,
  listRetailFinancialAccounts,
} from "../services/retail/retailFinancialQueries";

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

/** A positive amount up to 1,000,000,000, read exactly (never through a float). */
const exactAmountSchema = z.union([z.number(), z.string().trim()]).transform((value, ctx) => {
  const parsed =
    typeof value === "string" ? (/^\d+(\.\d+)?$/.test(value) ? parseMoneyInput(value) : null) : parseMoneyInput(value);
  if (!parsed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid amount" });
    return z.NEVER;
  }
  if (!parsed.gt(0) || parsed.gt(1000000000)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount must be positive and at most 1,000,000,000" });
    return z.NEVER;
  }
  return parsed.toDecimalPlaces(6);
});

const cashMovementSchema = z.object({
  movementType: z.enum(["cash_in", "cash_out"]),
  amount: exactAmountSchema,
  reason: z.string().trim().min(2).max(500),
  // Wave 17 (D): chooses the counter-account; a movement without one is "other" (refused until mapped).
  reasonCode: z.string().trim().regex(RETAIL_CASH_REASON_CODE).optional(),
  idempotencyKey: z.string().trim().min(8).max(191),
});

async function assertAccountOwnership(companyId: number, patch: z.infer<typeof settingsSchema>): Promise<void> {
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
    if (owned.length !== new Set(ledgerIds).size)
      throw new Error("One or more Retail ledger accounts belong to another company");
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
      // Saved and audited in one transaction (wave 17 C).
      res.json(
        await saveRetailAccountingSettings(companyId, locationId ?? null, patch, {
          userId: currentUserId(req),
          username: req.user?.username ?? req.session.username ?? "unknown",
        })
      );
    } catch (error) {
      if (error instanceof RetailAccountConflictError) {
        return res.status(409).json({ message: error.message, code: error.code, conflicts: error.conflicts });
      }
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
      if (!isCashAmountInCents(body.amount)) return res.status(400).json({ message: RETAIL_CASH_AMOUNT_CENTS_MESSAGE });
      const reasonCode = body.reasonCode ?? "other";
      const userId = currentUserId(req);
      const username = req.user?.username ?? req.session.username ?? "unknown";

      // Shared lock on the shift: closeShift locks it FOR UPDATE, so a movement either
      // commits before the close totals are read or sees the shift closed.
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ status: posShifts.status })
          .from(posShifts)
          .where(and(eq(posShifts.id, shiftId), eq(posShifts.companyId, companyId)))
          .for("share");
        if (locked?.status !== "open") return null;
        const [created] = await tx
          .insert(retailCashMovements)
          .values({
            companyId,
            locationId: shift.locationId,
            shiftId,
            movementType: body.movementType,
            amount: body.amount.toFixed(6),
            reason: body.reason,
            reasonCode,
            idempotencyKey: body.idempotencyKey,
            createdBy: userId,
          })
          .onConflictDoNothing({ target: [retailCashMovements.companyId, retailCashMovements.idempotencyKey] })
          .returning();
        // Wave 17 (D): journalled in the movement's transaction (shift cash against the
        // reason's account); an unmapped reason refuses the movement and nothing is written.
        let voucherId: number | null = null;
        if (created) {
          const target = await assertRetailCashReasonPostableTx(tx, companyId, reasonCode, body.movementType);
          voucherId = await postRetailCashMovementTx(tx, {
            companyId,
            shift: { id: shiftId, locationId: shift.locationId, cashAccountId: shift.cashAccountId ?? null },
            movement: {
              id: created.id,
              movementType: body.movementType,
              amount: body.amount,
              reason: body.reason,
            },
            target,
            actor: { userId, username },
          });
        }
        // Audited in the movement's transaction (wave 17 C); a replay writes nothing.
        if (created) {
          await writeAuditEvent(
            {
              userId,
              username,
              companyId,
              action: "create",
              tableName: "retail_cash_movements",
              recordId: created.id,
              recordIdentifier: `shift ${shiftId} ${body.movementType}`,
              changes: {
                movement: {
                  new: {
                    shiftId,
                    locationId: shift.locationId,
                    movementType: body.movementType,
                    amount: String(created.amount),
                    reason: body.reason,
                    reasonCode,
                    voucherId,
                  },
                },
              },
            },
            tx
          );
        }

        const row =
          created ??
          (
            await tx
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
        return { created, row };
      });
      if (!result) return res.status(409).json({ message: "Shift is already closed" });
      const { created, row } = result;
      if (!row) throw new Error("Cash movement retry could not be resolved");
      if (
        !created &&
        (row.shiftId !== shiftId ||
          row.movementType !== body.movementType ||
          !toMoney(row.amount).eq(body.amount) ||
          row.reason !== body.reason ||
          (row.reasonCode ?? "other") !== reasonCode)
      ) {
        return res.status(409).json({ message: "Cash movement idempotency key was reused with different data" });
      }
      res.status(created ? 201 : 200).json({
        replayed: !created,
        movement: row,
        summary: await getRetailShiftSummary(companyId, shiftId),
      });
    } catch (error) {
      if (error instanceof RetailCashReasonUnmappedError) return res.status(409).json(error.body);
      if (error instanceof RetailAccountConflictError) {
        return res.status(409).json({ message: error.message, code: error.code, conflicts: error.conflicts });
      }
      if (error instanceof HttpError) return res.status(error.statusCode).json({ message: error.message });
      const closed = closedPeriodErrorResponse(error);
      if (closed) return res.status(closed.status).json(closed.body);
      const message = getErrorMessage(error);
      res.status(message.includes("only access") ? 403 : 400).json({ message });
    }
  });

  // Wave 17 (D): cash movement reasons, the Retail inventory opening and its reconciliation.
  registerRetailLedgerRoutes(app);
}
