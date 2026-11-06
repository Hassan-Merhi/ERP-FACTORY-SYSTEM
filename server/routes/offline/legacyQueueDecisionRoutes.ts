/**
 * Plan batch 5 (owner-approved 2026-11-05): the old browser queues.
 *
 * Entries saved by the pre-Phase 9 offline queues are never sent
 * automatically. At sign-in the browser moves them into its encrypted store
 * and lists them. For each entry the user chooses to re-enter it (through the
 * normal form and its checks) or to discard it. This route records that choice
 * in the audit log with the user's name. It writes nothing else: the entry
 * itself never reaches the server through this route.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { logAudit } from "../_helpers";

const decisionSchema = z
  .object({
    entryId: z.string().min(1).max(200),
    decision: z.enum(["discarded", "re-entered"]),
    kind: z.string().min(1).max(200),
    recordedAt: z.string().datetime(),
    amount: z.string().max(40).nullable(),
    source: z.enum(["localStorage", "indexedDb"]),
  })
  .strict();

export function registerLegacyQueueDecisionRoutes(app: Express): void {
  app.post("/api/offline/legacy-queue/decisions", requireAuth, async (req: Request, res: Response) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "LEGACY_QUEUE_DECISION_INVALID" });
    const companyId = req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ code: "LEGACY_QUEUE_COMPANY_REQUIRED" });
    const decision = parsed.data;
    await logAudit({
      userId: String(req.session.userId),
      username: req.session.username || "unknown",
      companyId,
      action: decision.decision === "discarded" ? "delete" : "update",
      tableName: "offline_legacy_queue_entries",
      recordIdentifier: decision.entryId,
      changes: {
        decision: { new: decision.decision },
        kind: { new: decision.kind },
        recordedAt: { new: decision.recordedAt },
        amount: { new: decision.amount },
        source: { new: decision.source },
      },
    });
    return res.status(201).json({ recorded: true });
  });
}
