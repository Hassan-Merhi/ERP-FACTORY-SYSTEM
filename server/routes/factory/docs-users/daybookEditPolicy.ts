import type { Request } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { reverseTargetBonusPayment } from "../../../services/factory/targetBonusPaymentService";
import { reverseWeeklyBonusPayment } from "../../../services/factory/weeklyBonusPaymentService";

/**
 * Posting source types of the factory employee cash vouchers whose void moves
 * the employee balances back (the engine-numbered successors of EMP-DEP- /
 * EMP-WD- / EMP-PAY-; see employee-crud/cash.ts, bulk-withdraw.ts, bulk-payroll.ts).
 */
export const EMPLOYEE_CASH_POSTING_SOURCE_TYPES = [
  "factory-employee-deposit",
  "factory-employee-withdrawal",
  "factory-bulk-withdrawal",
  "factory-bulk-payroll",
];

/** A voucher's exchange rate; a missing, zero or unreadable one counts as 1. */
export const voucherFxRate = (rate: MoneyInput) => {
  const parsed = toMoney(rate || "1");
  return parsed.isZero() ? new MoneyDecimal(1) : parsed;
};

/** Production Targets bonus payment behind a Daybook row, if any. */
export const bonusSource = (table: string | null, id: number | null) => {
  if (!id || !Number.isSafeInteger(id) || id <= 0) return null;
  if (table === "factory_target_bonus_payments") return { kind: "daily" as const, id };
  if (table === "factory_target_bonus_weekly_payments") return { kind: "weekly" as const, id };
  return null;
};
export const reverseBonusFromDaybook = async (
  req: Request,
  companyId: number,
  source: { kind: "daily" | "weekly"; id: number }
) => {
  const userId = String(req.session.userId || "");
  const actor = { userId, username: String(req.session.username || userId) };
  const reason = "Deleted from Factory Daybook (accounting reversal)";
  const date = getClientDate(req);
  return source.kind === "daily"
    ? reverseTargetBonusPayment(companyId, source.id, date, reason, actor)
    : reverseWeeklyBonusPayment(companyId, source.id, date, reason, actor);
};
