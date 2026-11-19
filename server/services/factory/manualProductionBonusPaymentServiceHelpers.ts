// Extracted from ./manualProductionBonusPaymentService.ts
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { resultRows } from "../../lib/queryResult";
import { exactBonusCents, isRealBonusDate } from "./targetBonusPaymentPolicy";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";

type Row = Record<string, unknown>;

export const first = (result: unknown): Row | undefined => resultRows<Row>(result)[0];

export const all = (result: unknown): Row[] => resultRows<Row>(result);

// Annotated so a call narrows like a throw (TypeScript only narrows on
// never-returning functions with an explicit type).
export const bad: (status: number, message: string) => never = (status, message) => {
  throw new HttpError(status, message);
};

export const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type ManualBonusSelection = { workerId: number; amount: string };

export type ManualBonusCommand = {
  weekStart: string;
  rosterDate: string;
  paymentDate: string;
  cashAccountId: number;
  requestKey: string;
  selections: ManualBonusSelection[];
};

export function parseManualBonusCommand(raw: unknown): ManualBonusCommand {
  if (!raw || typeof raw !== "object") bad(400, "Payment details are required");
  const value = raw as Record<string, unknown>;
  if (value.confirm !== true) bad(400, "Confirm the manually entered amounts before posting");
  if (value.currency !== "USD") bad(400, "Only USD is supported for manual worker bonuses");
  if (!isRealBonusDate(value.weekStart) || mondayOfProductionBonusWeek(value.weekStart) !== value.weekStart)
    bad(400, "Choose a production week starting on Monday");
  if (
    !isRealBonusDate(value.rosterDate) ||
    value.rosterDate < value.weekStart ||
    value.rosterDate > new Date(Date.parse(value.weekStart + "T12:00:00Z") + 6 * 86400000).toISOString().slice(0, 10)
  )
    bad(400, "Select a roster date within the production week");
  if (!isRealBonusDate(value.paymentDate) || value.paymentDate < value.weekStart)
    bad(400, "Payment date cannot precede the selected production week");
  if (!id(value.cashAccountId)) bad(400, "Choose an active USD Cash or Bank account");
  if (
    typeof value.requestKey !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.requestKey)
  )
    bad(400, "Invalid payment request identity. Refresh and try again");
  if (!Array.isArray(value.selections) || !value.selections.length || value.selections.length > 100)
    bad(400, "Select between 1 and 100 workers");
  const seen = new Set<number>();
  const selections = value.selections
    .map((entry: unknown): ManualBonusSelection => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const amount = exactBonusCents(item.amount);
      if (!id(item.workerId) || !amount || Number(amount) > 1000000)
        bad(400, "Every selected worker needs a positive USD amount up to $1,000,000");
      if (seen.has(item.workerId)) bad(400, "A worker cannot be selected twice");
      seen.add(item.workerId);
      return { workerId: item.workerId as number, amount };
    })
    .sort((a, b) => a.workerId - b.workerId);
  return {
    weekStart: value.weekStart,
    rosterDate: value.rosterDate,
    paymentDate: value.paymentDate,
    cashAccountId: value.cashAccountId as number,
    requestKey: value.requestKey.toLowerCase(),
    selections,
  };
}

export async function conflictingAwardTx(tx: DbTransaction, companyId: number, workerId: number, weekStart: string) {
  const existing = first(
    await tx.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM factory_target_bonus_weekly_payments
        WHERE company_id=${companyId} AND worker_id=${workerId}
          AND week_start=${weekStart}::date AND status='POSTED') AS weekly,
      EXISTS (SELECT 1 FROM factory_target_bonus_payments
        WHERE company_id=${companyId} AND worker_id=${workerId}
          AND production_date BETWEEN ${weekStart}::date AND ${weekStart}::date + 6
          AND status='POSTED') AS daily
  `)
  );
  if (existing?.weekly === true || existing?.daily === true)
    bad(
      409,
      "This worker already has a posted calculated bonus for the same week. Reconcile before a manual bonus payout"
    );
}
