import Decimal from "decimal.js";
import { isBonusCategoryDate, normalizeBonusCategory } from "./productionTargetBonusCategoryRates";
import { isProductionWorkday, mondayOfProductionBonusWeek, type ProductionBonusMethod } from "./productionTargetBonusWeeklyMethod";

export const WEEKLY_FLAT_BONUS_CALCULATION_VERSION = "production-target-weekly-flat-v1" as const;

export type WeeklyFlatBonusIssue =
  | "WEEK_NOT_FINISHED"
  | "NO_FLAT_BONUS_METHOD"
  | "NO_PRODUCTION_DAYS"
  | "UNFINALIZED_DAY"
  | "MISSING_FROZEN_EVIDENCE"
  | "AMBIGUOUS_FROZEN_EVIDENCE"
  | "NO_ACTIVE_DAYS"
  | "NO_DAILY_TARGET"
  | "INVALID_DAILY_TARGET"
  | "INVALID_DAILY_CREDIT"
  | "ABSENT_WITH_PRODUCTION"
  | "DUPLICATE_WORKER_DAY"
  | "EXISTING_DAILY_BONUS_REVIEW"
  | "EXISTING_PAYROLL_BONUS_CLAIM"
  | "DUPLICATE_SOURCE_BALE";

export interface WeeklyFlatDayWorker {
  workerId: number;
  workerName: string;
  status: "Present" | "Absent" | "New";
  targetBales: number | null;
  creditedBales: number;
  categories: Array<{ categoryKey: string; categoryLabel: string; creditedBales: number }>;
}

export interface WeeklyFlatDayEvidence {
  date: string;
  finalized: boolean;
  captured: boolean;
  verified: boolean;
  issues: string[];
  sourceBales: number;
  creditedBales: number;
  workers: WeeklyFlatDayWorker[];
}

export interface WeeklyFlatBonusInput {
  weekStart: string;
  /** Local Asia/Beirut calendar day, supplied by the server. */
  todayBeirut: string;
  method: ProductionBonusMethod;
  methodVersionId: number | null;
  flatBonusUsd: string;
  days: WeeklyFlatDayEvidence[];
  /** Saved but not finalized dates must block the whole week. */
  unfinalizedDates: string[];
  repeatedBaleInWeek?: boolean;
  /** All existing legacy/category reviews including rejections, by worker/day. */
  previouslyReviewedWorkerDays?: ReadonlySet<string>;
  /** Previously committed payroll production bonus claims, by worker/day. */
  payrollClaimedWorkerDays?: ReadonlySet<string>;
}

export interface WeeklyFlatWorkerProposal {
  workerId: number;
  workerName: string;
  targetBales: string;
  creditedBales: number;
  extraBales: string;
  workedDays: number;
  absentDays: number;
  categories: Array<{ categoryKey: string; categoryLabel: string; creditedBales: number }>;
  dayBreakdown: Array<{ date: string; status: WeeklyFlatDayWorker["status"]; targetBales: string | null; creditedBales: number }>;
  reasons: WeeklyFlatBonusIssue[];
  blocked: boolean;
  exceedsTarget: boolean;
  eligible: boolean;
  proposedBonusUsd: string;
}

export interface WeeklyFlatBonusProposal {
  calculationVersion: typeof WEEKLY_FLAT_BONUS_CALCULATION_VERSION;
  currency: "USD";
  proposalOnly: true;
  canApprove: false;
  canPost: false;
  method: ProductionBonusMethod;
  methodVersionId: number | null;
  flatBonusUsd: string;
  weekStart: string;
  weekEnd: string;
  completeWeek: boolean;
  globalIssues: WeeklyFlatBonusIssue[];
  totalCreditedBales: number;
  totalProposedBonusUsd: string;
  workers: WeeklyFlatWorkerProposal[];
}

function addDays(date: string, count: number): string {
  const d = new Date(date + "T12:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
function validTarget(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0 && value <= 100000 &&
    Number.isSafeInteger(Math.round(value * 100)) &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}
function validCredit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read-only worker/week calculation.
 * - One weekly total per worker ID (not one payout per category or per day).
 * - Counts immutable, physically attributed category bales once, including linked shares.
 * - Uses each non-absent day's single finalized worker target once.
 * - Does not approve/pay anything; existing daily claims explicitly block eligibility.
 */
export function calculateWeeklyFlatBonus(input: WeeklyFlatBonusInput): WeeklyFlatBonusProposal {
  if (!isBonusCategoryDate(input.weekStart) ||
      mondayOfProductionBonusWeek(input.weekStart) !== input.weekStart ||
      !isBonusCategoryDate(input.todayBeirut)) throw new Error("Invalid production bonus week");
  const weekEnd = addDays(input.weekStart, 6);
  const completeWeek = weekEnd < input.todayBeirut;
  const global = new Set<WeeklyFlatBonusIssue>();
  if (!completeWeek) global.add("WEEK_NOT_FINISHED");
  if (input.method !== "weekly_flat" || !input.methodVersionId ||
      !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(input.flatBonusUsd) ||
      !new Decimal(input.flatBonusUsd).greaterThan(0) ||
      new Decimal(input.flatBonusUsd).greaterThan(100000))
    global.add("NO_FLAT_BONUS_METHOD");
  // Sunday is a factory holiday, not an absent shift or a required capture.
  if (input.days.some(day => !isBonusCategoryDate(day.date) ||
      day.date < input.weekStart || day.date > weekEnd))
    throw new Error("Invalid weekly source date");
  const workingDays = input.days.filter(day => isProductionWorkday(day.date));
  if (!workingDays.length) global.add("NO_PRODUCTION_DAYS");
  if (input.unfinalizedDates.some(date => !isBonusCategoryDate(date) || date < input.weekStart || date > weekEnd))
    throw new Error("Unfinalized source outside selected production week");
  if (input.unfinalizedDates.some(date => isProductionWorkday(date))) global.add("UNFINALIZED_DAY");
  if (input.repeatedBaleInWeek) global.add("DUPLICATE_SOURCE_BALE");

  const seenDates = new Set<string>();
  const workers = new Map<number, {
    workerId: number; workerName: string; target: Decimal; creditedBales: number;
    workedDays: number; absentDays: number;
    categories: Map<string, { categoryKey: string; categoryLabel: string; creditedBales: number }>;
    dayBreakdown: WeeklyFlatWorkerProposal["dayBreakdown"];
    reasons: Set<WeeklyFlatBonusIssue>;
  }>();
  let physicalTotal = 0;
  for (const day of [...workingDays].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!isBonusCategoryDate(day.date) || day.date < input.weekStart || day.date > weekEnd ||
        seenDates.has(day.date)) throw new Error("Duplicated or invalid weekly source date");
    seenDates.add(day.date);
    if (!day.finalized) global.add("UNFINALIZED_DAY");
    if (!day.captured) global.add("MISSING_FROZEN_EVIDENCE");
    if (!day.verified || day.issues.length) global.add("AMBIGUOUS_FROZEN_EVIDENCE");
    if (!validCredit(day.sourceBales) || !validCredit(day.creditedBales) ||
        day.sourceBales !== day.creditedBales) global.add("AMBIGUOUS_FROZEN_EVIDENCE");
    physicalTotal += day.creditedBales;

    const dayWorkers = new Set<number>();
    let summedDayCredits = 0;
    for (const person of day.workers) {
      if (!Number.isSafeInteger(person.workerId) || person.workerId <= 0 ||
          dayWorkers.has(person.workerId)) {
        global.add("AMBIGUOUS_FROZEN_EVIDENCE");
        continue;
      }
      dayWorkers.add(person.workerId);
      const entry = workers.get(person.workerId) ?? {
        workerId: person.workerId, workerName: person.workerName, target: new Decimal(0),
        creditedBales: 0, workedDays: 0, absentDays: 0,
        categories: new Map<string, { categoryKey: string; categoryLabel: string; creditedBales: number }>(),
        dayBreakdown: [] as WeeklyFlatWorkerProposal["dayBreakdown"], reasons: new Set<WeeklyFlatBonusIssue>(),
      };
      if (!validCredit(person.creditedBales)) entry.reasons.add("INVALID_DAILY_CREDIT");
      else {
        entry.creditedBales += person.creditedBales;
        summedDayCredits += person.creditedBales;
      }
      if (person.status === "Absent") {
        entry.absentDays++;
        if (person.creditedBales !== 0) entry.reasons.add("ABSENT_WITH_PRODUCTION");
        // Absence is not a worked shift; do not charge its target to the worker.
      } else {
        entry.workedDays++;
        if (!validTarget(person.targetBales)) {
          entry.reasons.add(person.targetBales === null ? "NO_DAILY_TARGET" : "INVALID_DAILY_TARGET");
        } else {
          entry.target = entry.target.plus(person.targetBales);
        }
      }
      if (input.previouslyReviewedWorkerDays?.has(day.date + ":" + person.workerId))
        entry.reasons.add("EXISTING_DAILY_BONUS_REVIEW");
      if (input.payrollClaimedWorkerDays?.has(day.date + ":" + person.workerId))
        entry.reasons.add("EXISTING_PAYROLL_BONUS_CLAIM");
      const grouped = new Set<string>();
      let categoriesCredited = 0;
      for (const category of person.categories) {
        const normalized = normalizeBonusCategory(category.categoryLabel);
        if (!normalized || normalized.key !== category.categoryKey ||
            grouped.has(category.categoryKey) || !validCredit(category.creditedBales)) {
          entry.reasons.add("INVALID_DAILY_CREDIT");
          continue;
        }
        grouped.add(category.categoryKey);
        categoriesCredited += category.creditedBales;
        const old = entry.categories.get(normalized.key);
        entry.categories.set(normalized.key, {
          categoryKey: normalized.key, categoryLabel: normalized.label,
          creditedBales: (old?.creditedBales ?? 0) + category.creditedBales,
        });
      }
      if (categoriesCredited !== person.creditedBales) entry.reasons.add("INVALID_DAILY_CREDIT");
      entry.dayBreakdown.push({
        date: day.date, status: person.status,
        targetBales: person.targetBales === null ? null : new Decimal(person.targetBales).toFixed(2),
        creditedBales: person.creditedBales,
      });
      workers.set(person.workerId, entry);
    }
    if (summedDayCredits !== day.creditedBales) global.add("AMBIGUOUS_FROZEN_EVIDENCE");
  }

  const entries = [...workers.values()].map(entry => {
    const reasons = new Set([...global, ...entry.reasons]);
    if (!entry.workedDays) reasons.add("NO_ACTIVE_DAYS");
    const extra = Decimal.max(0, new Decimal(entry.creditedBales).minus(entry.target));
    const exceedsTarget = extra.greaterThan(0);
    const blocked = reasons.size > 0;
    const eligible = !blocked && exceedsTarget;
    return {
      workerId: entry.workerId, workerName: entry.workerName,
      targetBales: entry.target.toFixed(2), creditedBales: entry.creditedBales,
      extraBales: extra.toFixed(2), workedDays: entry.workedDays, absentDays: entry.absentDays,
      categories: [...entry.categories.values()].sort((a, b) => a.categoryKey.localeCompare(b.categoryKey)),
      dayBreakdown: entry.dayBreakdown,
      reasons: [...reasons], blocked, exceedsTarget, eligible,
      proposedBonusUsd: eligible ? new Decimal(input.flatBonusUsd).toFixed(2) : "0.00",
    };
  }).sort((a, b) => a.workerName.localeCompare(b.workerName) || a.workerId - b.workerId);
  return {
    calculationVersion: WEEKLY_FLAT_BONUS_CALCULATION_VERSION, currency: "USD",
    proposalOnly: true, canApprove: false, canPost: false,
    method: input.method, methodVersionId: input.methodVersionId,
    flatBonusUsd: input.method === "weekly_flat" ? input.flatBonusUsd : "0.00",
    weekStart: input.weekStart, weekEnd, completeWeek,
    globalIssues: [...global], totalCreditedBales: physicalTotal,
    totalProposedBonusUsd: entries.reduce((sum, worker) =>
      sum.plus(worker.proposedBonusUsd), new Decimal(0)).toFixed(2),
    workers: entries,
  };
}
