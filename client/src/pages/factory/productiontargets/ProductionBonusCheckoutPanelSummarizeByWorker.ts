// Extracted from ./ProductionBonusCheckoutPanel.tsx to keep that module under the source-size cap.
import { factoryApiRequest } from "@/lib/factoryApi";

export type Method = "standard" | "category";

type Line = { category: string; produced: number; extra: number; rate: string; bonus: string };

export type Offer = {
  date: string;
  workerId: number;
  workerName: string;
  linkGroupId: number | null;
  category: string;
  target: number;
  produced: number;
  extra: number;
  method: Method;
  lines: Line[];
  amount: string;
  token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "no_bonus" | "needs_setup" | "blocked" | "rejected" | "weekly";
  issue: string | null;
  weeklyBonus?: { weekStart: string; amount: string; state: "projected" | "approved" };
};

export type Preview = { from: string; to: string; method: Method; currency: "USD"; offers: Offer[] };

export type Account = { id: number; name: string; code: string; openingCurrency: string | null };

export type PaymentRow = {
  reviewId: number;
  workerId: number;
  date: string;
  paymentId: number | null;
  paymentStatus: "POSTED" | "REVERSED" | null;
  cashAccountName: string | null;
  voucherId: number | null;
};

export const endpoint = "/api/factory/production-target-bonuses/checkout";

export const isDate = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(date + "T12:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
};

export const daysApart = (from: string, to: string) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);

export const startOfRange = (date: string) => {
  if (!isDate(date)) return date;
  const d = new Date(date + "T12:00:00Z");
  // The default checkout period follows the production week (Monday onward).
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export const payableStatus = (row: Offer) => row.status === "pending" || row.status === "approved";

type WorkerGroup = {
  workerId: number;
  workerName: string;
  days: Offer[];
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

export function summarizeByWorker(offers: Offer[]): WorkerGroup[] {
  const map = new Map<number, WorkerGroup>();
  for (const row of offers) {
    let group = map.get(row.workerId);
    if (!group) {
      group = {
        workerId: row.workerId,
        workerName: row.workerName,
        days: [],
        target: 0,
        produced: 0,
        extra: 0,
        amount: 0,
        weeklyAmount: 0,
        weeklyProjected: false,
        weeklyApproved: false,
        readyDays: 0,
        paidDays: 0,
        needsSetup: 0,
        blockedDays: 0,
        weeklyDays: 0,
      };
      map.set(row.workerId, group);
    }
    group.days.push(row);
    group.target += row.target;
    group.produced += row.produced;
    group.extra += row.extra;
    if (payableStatus(row)) {
      group.readyDays++;
      group.amount += Math.round(Number(row.amount) * 100);
    }
    if (row.status === "paid") group.paidDays++;
    if (row.status === "needs_setup") group.needsSetup++;
    if (row.status === "blocked") group.blockedDays++;
    if (row.status === "weekly") group.weeklyDays++;
    if (row.weeklyBonus) {
      group.weeklyAmount += Math.round(Number(row.weeklyBonus.amount) * 100);
      if (row.weeklyBonus.state === "projected") group.weeklyProjected = true;
      if (row.weeklyBonus.state === "approved") group.weeklyApproved = true;
    }
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      amount: g.amount / 100,
      weeklyAmount: g.weeklyAmount / 100,
      days: g.days.sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => a.workerName.localeCompare(b.workerName));
}

export const usd = (amount: string | number) =>
  Number(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, path, body);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Bonus request failed");
  return data as T;
}
