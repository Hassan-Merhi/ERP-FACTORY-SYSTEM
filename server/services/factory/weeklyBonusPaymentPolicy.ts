/** Strict USD-only, confirmed weekly payroll-bonus payment commands. */
import { isRealBonusDate, exactBonusCents, TargetBonusPaymentPolicyError } from "./targetBonusPaymentPolicy";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";

export interface WeeklyBonusPaymentSelection {
  weekStart: string;
  workerId: number;
  expectedAmount: string;
}
export interface WeeklyBonusPaymentCommand {
  confirm: true;
  paymentDate: string;
  cashAccountId: number;
  currency: "USD";
  selections: WeeklyBonusPaymentSelection[];
}
export function parseWeeklyBonusPaymentCommand(value: unknown): WeeklyBonusPaymentCommand {
  const bad = (message: string): never => { throw new TargetBonusPaymentPolicyError(400, message); };
  if (!value || typeof value !== "object") return bad("Payment details are required");
  const raw = value as Record<string, unknown>;
  if (raw.confirm !== true) return bad("Confirm the reviewed weekly payment before posting");
  if (!isRealBonusDate(raw.paymentDate)) return bad("Choose a valid payment date");
  if (typeof raw.cashAccountId !== "number" || !Number.isSafeInteger(raw.cashAccountId) ||
      raw.cashAccountId <= 0) return bad("Choose a Cash or Bank payment account");
  if (String(raw.currency ?? "USD").toUpperCase() !== "USD")
    return bad("Only USD bonus payments are supported without verified FX");
  if (!Array.isArray(raw.selections) || raw.selections.length < 1 || raw.selections.length > 100)
    return bad("Select 1 to 100 approved weekly bonuses");
  const seen = new Set<string>();
  const selections: WeeklyBonusPaymentSelection[] = raw.selections.map((rawRow: unknown) => {
    const row = rawRow && typeof rawRow === "object" ? rawRow as Record<string, unknown> : {};
    if (!isRealBonusDate(row.weekStart) ||
        mondayOfProductionBonusWeek(row.weekStart) !== row.weekStart ||
        typeof row.workerId !== "number" || !Number.isSafeInteger(row.workerId) || row.workerId <= 0)
      return bad("Each payment must identify a valid worker and Monday production week");
    const expectedAmount = exactBonusCents(row.expectedAmount);
    if (!expectedAmount) return bad("Each payment requires an exact positive USD amount");
    const key = row.weekStart + ":" + row.workerId;
    if (seen.has(key)) return bad("Duplicate worker/week payment selection");
    seen.add(key);
    return { weekStart: row.weekStart, workerId: row.workerId, expectedAmount };
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.workerId - b.workerId);
  return {
    confirm: true, paymentDate: raw.paymentDate, cashAccountId: raw.cashAccountId as number,
    currency: "USD", selections,
  };
}
