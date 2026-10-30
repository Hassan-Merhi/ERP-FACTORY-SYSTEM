/** Pure request validation and duplicate guard for Production Targets bonus payouts. */
import Decimal from "decimal.js";

export type TargetBonusPaymentSelection = {
  date: string;
  workerId: number;
  expectedAmount: string;
};

export type TargetBonusPaymentCommand = {
  paymentDate: string;
  cashAccountId: number;
  currency: string;
  confirm: boolean;
  selections: TargetBonusPaymentSelection[];
};

export class TargetBonusPaymentPolicyError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function isRealBonusDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function exactBonusCents(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const candidate = String(value);
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(candidate)) return null;
  const amount = new Decimal(candidate);
  return amount.gt(0) ? amount.toFixed(2) : null;
}

export function parseTargetBonusPaymentCommand(raw: unknown): TargetBonusPaymentCommand {
  if (!raw || typeof raw !== "object") throw new TargetBonusPaymentPolicyError(400, "Payment details are required");
  const value = raw as Record<string, unknown>;
  if (value.confirm !== true) throw new TargetBonusPaymentPolicyError(400, "Review and confirm the payment before posting");
  if (!isRealBonusDate(value.paymentDate)) throw new TargetBonusPaymentPolicyError(400, "Choose a valid payment date");
  if (!Number.isSafeInteger(value.cashAccountId) || Number(value.cashAccountId) <= 0)
    throw new TargetBonusPaymentPolicyError(400, "Choose a paying Cash or Bank account");
  // This bonus entitlement is denominated in USD. Currency conversion requires
  // a separately confirmed native amount and dated FX rate, never an assumed rate.
  const currency = String(value.currency ?? "USD").trim().toUpperCase();
  if (currency !== "USD") throw new TargetBonusPaymentPolicyError(400, "Only USD payment is supported until FX is verified");
  if (!Array.isArray(value.selections) || value.selections.length === 0 || value.selections.length > 100)
    throw new TargetBonusPaymentPolicyError(400, "Choose between 1 and 100 reviewed bonuses");

  const keys = new Set<string>();
  const selections = value.selections.map((item: unknown) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const date = row.date;
    const workerId = row.workerId;
    const expectedAmount = exactBonusCents(row.expectedAmount);
    if (!isRealBonusDate(date) || !Number.isSafeInteger(workerId) || Number(workerId) <= 0 || !expectedAmount)
      throw new TargetBonusPaymentPolicyError(400, "Each selection needs a worker, production date and positive approved amount");
    const key = date + ":" + workerId;
    if (keys.has(key)) throw new TargetBonusPaymentPolicyError(400, "Duplicate worker/day in payment selection");
    keys.add(key);
    return { date, workerId: workerId as number, expectedAmount };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.workerId - b.workerId);
  return { paymentDate: value.paymentDate, cashAccountId: value.cashAccountId as number, currency, confirm: true, selections };
}

export function decideTargetBonusPaymentState(
  status: string,
  recordedAmount: string,
  expectedAmount: string,
  alreadyPosted: boolean,
  conflictsWithPayroll: boolean,
): "POST" | "REPLAY" {
  if (recordedAmount !== expectedAmount) throw new TargetBonusPaymentPolicyError(409, "Bonus changed since review; reload the approved amount");
  if (alreadyPosted) return "REPLAY";
  if (status !== "approved") throw new TargetBonusPaymentPolicyError(409, "Only approved bonuses can be paid");
  if (conflictsWithPayroll) throw new TargetBonusPaymentPolicyError(409, "Worker/day has an approved payroll bonus; reconcile it before direct payment");
  return "POST";
}
