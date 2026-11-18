// Extracted from ./smartTransferFeedback.ts
import { randomUUID } from "crypto";
import { db } from "../db";
import { aiActionLog } from "@shared/schema";
import { RESET_ACTION } from "./createSmartTransferPreviewFeedback";

export function weightedAverage(entries: Array<{ value: number; weight: number }>): number {
  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (totalWeight <= 0) return 0;
  return entries.reduce((sum, entry) => sum + entry.value * Math.max(0, entry.weight), 0) / totalWeight;
}

export async function resetSmartTransferFeedback(params: { companyId: number; userId: string }): Promise<string> {
  const sessionId = `stf_reset_${randomUUID()}`;
  await db.insert(aiActionLog).values({
    companyId: params.companyId,
    userId: params.userId,
    sessionId,
    actionType: "write",
    actionName: RESET_ACTION,
    outputJson: { resetAt: new Date().toISOString() },
    status: "success",
  });
  return sessionId;
}
