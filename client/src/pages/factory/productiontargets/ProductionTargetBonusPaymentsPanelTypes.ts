// Extracted from ./ProductionTargetBonusPaymentsPanel.tsx to keep that module under the source-size cap.
import { factoryApiRequest } from "@/lib/factoryApi";

type Account = { id: number; name: string; code: string; accountType: string; openingCurrency: string | null };

export type PaymentRow = {
  reviewId: number;
  date: string;
  workerId: number;
  workerName: string;
  decisionStatus: "approved" | "rejected";
  approvedAmount: string;
  targetBales: string;
  creditedBales: number;
  extraBales: string;
  ratePerBale: string;
  paymentId: number | null;
  paymentStatus: "POSTED" | "REVERSED" | null;
  paymentDate: string | null;
  cashAccountId: number | null;
  cashAccountName: string | null;
  voucherId: number | null;
  reversalVoucherId: number | null;
};

export type PaymentSummary = { payments: PaymentRow[]; start: string; end: string };

export type AccountResponse = { accounts: Account[]; currency: string };

export type PostResult = { posted: number; replayed: number };

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, path, body);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || "Bonus payment request failed");
  return result as T;
}

export const fmtAmount = (amount: string | number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD" });
