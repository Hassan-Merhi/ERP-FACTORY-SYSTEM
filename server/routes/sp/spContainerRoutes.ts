import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { eq, and, isNull, desc } from "drizzle-orm";
import { ledgerAccounts, bankAccounts, spPrepaidCharges } from "@shared/schema";
import { getClientDate } from "../../lib/dateUtils";
import { requireSpCompany, getSpAccount } from "./spHelpers";
import { parseMoneyInput, toMoney } from "../../lib/money";
import { postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { sendVoucherCorrectionRefusal } from "../../services/factory/factoryVoucherCorrection";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { registerSpContainerRoutesPart1 } from "./registerSpContainerRoutesPart1";
import { registerSpContainerRoutesPart2 } from "./registerSpContainerRoutesPart2";

// ── Containers + Prepaid Charges ─────────────────────────────────────────────

export function registerSpContainerRoutes(app: Express) {
  registerSpContainerRoutesPart1(app);
  registerSpContainerRoutesPart2(app);
  registerSpContainerRoutesPart3(app);
}

function registerSpContainerRoutesPart3(app: Express) {
  // ── Prepaid Charges ───────────────────────────────────────────────────────

  app.get("/api/sp/prepaid", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containerId = req.query.containerId ? parseInt(req.query.containerId as string) : null;

      const conditions = [eq(spPrepaidCharges.companyId, companyId)];
      if (containerId) conditions.push(eq(spPrepaidCharges.containerId, containerId));

      const rows = await db
        .select()
        .from(spPrepaidCharges)
        .where(and(...conditions))
        .orderBy(desc(spPrepaidCharges.createdAt));

      res.json(rows);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/prepaid", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { containerId, prepaidDate, chargeType, agentName, amountPaidUsd, bankAccountId, debitAccountId, notes } =
        req.body;

      if (!chargeType || !amountPaidUsd) {
        return res.status(400).json({ message: "chargeType, amountPaidUsd required" });
      }

      let prepaidAcct = await getSpAccount(companyId, "sp_prepaid");
      if (!prepaidAcct) return res.status(400).json({ message: "SP accounts not set up" });

      // Allow optional debit account override — validate it belongs to this company
      if (debitAccountId) {
        const [customDebit] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(debitAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customDebit) return res.status(400).json({ message: "Debit account not found for this company" });
        prepaidAcct = customDebit;
      }

      // Validate bank account belongs to this company
      if (bankAccountId) {
        const [bank] = await db
          .select()
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, parseInt(bankAccountId)), eq(bankAccounts.companyId, companyId)));
        if (!bank) return res.status(400).json({ message: "Bank account not found for this company" });
      }

      const amount = (parseMoneyInput(amountPaidUsd) ?? toMoney(0)).toDecimalPlaces(2);
      const date = prepaidDate || getClientDate(req);

      const result = await db.transaction(async (tx) => {
        const [charge] = await tx
          .insert(spPrepaidCharges)
          .values({
            companyId,
            containerId: containerId ? parseInt(containerId) : null,
            prepaidDate: date,
            chargeType,
            agentName: agentName || null,
            amountPaidUsd: amount.toFixed(2),
            amountUsedUsd: "0",
            notes: notes || null,
          })
          .returning();

        const desc = `Prepaid ${chargeType}${agentName ? ` — ${agentName}` : ""} for container #${containerId}`;
        // Phase 22 (C): through the engine with the prepaid charge's identity
        // (SP-PRE- family number kept, deterministic suffix).
        const { voucher } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `SP-PRE-${charge.id}-${generation}`,
          voucherDate: date,
          description: desc,
          sourceModule: "SP",
          source: { sourceType: "sp-prepaid-charge", sourceId: charge.id, phase: "voucher" },
          lines: [
            // Dr Prepaid Charges / Cr Bank
            { ledgerAccountId: prepaidAcct.id, debit: amount, narration: `Prepaid ${chargeType} — ${agentName || ""}` },
            ...(bankAccountId
              ? [
                  {
                    bankAccountId: parseInt(bankAccountId),
                    credit: amount,
                    narration: `Payment for prepaid ${chargeType}`,
                  },
                ]
              : []),
          ],
        });

        await tx.update(spPrepaidCharges).set({ voucherId: voucher.id }).where(eq(spPrepaidCharges.id, charge.id));

        return { ...charge, voucherId: voucher.id };
      });

      res.json(result);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
