// Extracted from ./ProductionBonusWeeklySheetLinkedDailyProgress.tsx
import { type ReactNode } from "react";

/** Display only: calculated amounts/eligibility come from the checkout API. */
export type BonusSheetDay = {
  date: string;
  target: number;
  produced: number;
  extra: number;
  category: string;
  issue: string | null;
  status: string;
  linkGroupId: number | null;
};

export type BonusSheetWorker = {
  workerId: number;
  workerName: string;
  days: BonusSheetDay[];
  target: number;
  produced: number;
  extra: number;
  amount: number;
  weeklyAmount: number;
  weeklyProjected: boolean;
  weeklyApproved: boolean;
  readyDays: number;
  paidDays: number;
  needsSetup: number;
  blockedDays: number;
  weeklyDays: number;
};

export type Props = {
  from: string;
  to: string;
  workers: BonusSheetWorker[];
  selected: number[];
  onToggle: (workerId: number, checked: boolean) => void;
  manualMode?: boolean;
  manualAmounts?: Record<number, string>;
  onAmountChange?: (workerId: number, amount: string) => void;
  manuallyPaidIds?: number[];
  renderDayActions?: (workerId: number, date: string) => ReactNode;
  loading: boolean;
};

export const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

export const avatarStyles = [
  "bg-sky-500/15 text-sky-500 dark:text-sky-300",
  "bg-violet-500/15 text-violet-500 dark:text-violet-300",
  "bg-amber-500/15 text-amber-500 dark:text-amber-300",
  "bg-teal-500/15 text-teal-600 dark:text-teal-300",
  "bg-rose-500/15 text-rose-500 dark:text-rose-300",
];
