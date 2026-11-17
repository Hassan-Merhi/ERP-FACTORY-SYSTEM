// Extracted from ./ProductionBonusesPanel.tsx to keep that module under the source-size cap.
import { factoryApiRequest } from "@/lib/factoryApi";

export type Decision = "approved" | "rejected";

export type Status = "pending" | Decision;

export interface BonusRow {
  date: string;
  workerId: number;
  workerName: string;
  category: string;
  linkGroupId: number | null;
  targetBales: number;
  producedBales: number;
  extraBales: number;
  ratePerBale: number | null;
  proposedAmount: number;
  status: Status;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lockedAmount: number | null;
  targetConfigured?: boolean;
  sourceFinalized?: boolean;
}

export interface BonusResponse {
  start: string;
  end: string;
  rows: BonusRow[];
  totals: {
    workers: number;
    extraBales: number;
    pendingAmount: number;
    approvedAmount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
  };
  canDecide: boolean;
}

export const EMPTY_BONUS_ROWS: BonusRow[] = [];

export const rowKey = (row: BonusRow) => row.date + ":" + row.workerId;

export const money = (amount: number) =>
  "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const count = (amount: number) => amount.toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, path, body);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || "Production bonus request failed");
  }
  return response.json() as Promise<T>;
}
