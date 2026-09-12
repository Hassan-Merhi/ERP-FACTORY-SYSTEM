/**
 * importExportRoutes: SnapshotPinnedAccount endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { snapshotPinnedAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerSnapshotPinnedAccountRoutes(app: Express) {
  // ── SNAPSHOT PINNED ACCOUNTS (supplier / customer / advance + future cards) ─
  const ALLOWED_CARD_KEYS = new Set(["supplier", "customer", "advance"]);

  app.get("/api/snapshot-pinned-accounts/:cardKey", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { cardKey } = req.params;
      if (!ALLOWED_CARD_KEYS.has(cardKey)) return res.status(400).json({ message: "Invalid cardKey" });
      const rows = await db
        .select()
        .from(snapshotPinnedAccounts)
        .where(and(eq(snapshotPinnedAccounts.companyId, companyId), eq(snapshotPinnedAccounts.cardKey, cardKey)));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/snapshot-pinned-accounts/:cardKey", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { cardKey } = req.params;
      if (!ALLOWED_CARD_KEYS.has(cardKey)) return res.status(400).json({ message: "Invalid cardKey" });
      const { accountId, accountType, accountName } = req.body;
      if (!accountId || !accountType || !accountName)
        return res.status(400).json({ message: "accountId, accountType, and accountName are required" });
      const [row] = await db
        .insert(snapshotPinnedAccounts)
        .values({ companyId, cardKey, accountId, accountType, accountName })
        .onConflictDoUpdate({
          target: [snapshotPinnedAccounts.companyId, snapshotPinnedAccounts.cardKey, snapshotPinnedAccounts.accountId],
          set: { accountName, accountType },
        })
        .returning();
      res.json(row);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/snapshot-pinned-accounts/:cardKey/:accountId", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { cardKey } = req.params;
      if (!ALLOWED_CARD_KEYS.has(cardKey)) return res.status(400).json({ message: "Invalid cardKey" });
      const accountId = decodeURIComponent(req.params.accountId);
      await db
        .delete(snapshotPinnedAccounts)
        .where(
          and(
            eq(snapshotPinnedAccounts.companyId, companyId),
            eq(snapshotPinnedAccounts.cardKey, cardKey),
            eq(snapshotPinnedAccounts.accountId, accountId)
          )
        );
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ACCOUNT MIGRATION — move ledger accounts + their statements between companies
  // Supports migrating multiple accounts at once in a single atomic transaction.
  // Voucher exclusivity is evaluated against the whole batch: a voucher that
  // touches only accounts within the migrating batch is moved entirely.
  // ═══════════════════════════════════════════════════════════════════════════
}
