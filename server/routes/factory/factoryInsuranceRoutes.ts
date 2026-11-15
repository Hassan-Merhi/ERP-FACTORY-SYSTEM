import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { insuranceMemberMonthlyAmounts, insuranceMembers } from "@shared/schema";
import { postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { infrastructurePostingIdentity } from "../../services/accounting/infrastructureVoucherIdentity";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import type Decimal from "decimal.js";
import { sumMoney, toMoney } from "../../lib/money";
import { findOrCreateLedger, sendRouteError } from "./factoryInsuranceRoutesFindOrCreateLedgerTx";
import { registerFactoryInsuranceRoutesPart1 } from "./registerFactoryInsuranceRoutesPart1";
import { registerFactoryInsuranceRoutesPart2 } from "./registerFactoryInsuranceRoutesPart2";

export function registerFactoryInsuranceRoutes(app: Express) {
  registerFactoryInsuranceRoutesPart1(app);
  registerFactoryInsuranceRoutesPart2(app);
  registerFactoryInsuranceRoutesPart3(app);
}

function registerFactoryInsuranceRoutesPart3(app: Express) {
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
      const memberLedgers: { ledgerId: number; amount: Decimal }[] = [];
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
        // At cents, so the expense credit is exactly the sum of the member debits.
        let memberAmount = toMoney(monthlyAmountByMember.get(member.id) ?? member.amount).toDecimalPlaces(2);
        if (member.startDate > periodStart && member.startDate <= periodEnd) {
          const startDay = parseInt(member.startDate.split("-")[2]);
          memberAmount = memberAmount
            .div(lastDay)
            .times(lastDay - startDay + 1)
            .toDecimalPlaces(2);
        }
        memberLedgers.push({ ledgerId, amount: memberAmount });
      }

      const totalAmount = sumMoney(memberLedgers.map((member) => member.amount));
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
