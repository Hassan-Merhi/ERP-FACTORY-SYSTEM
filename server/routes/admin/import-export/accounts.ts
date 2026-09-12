/**
 * importExportRoutes: AgentFreightAccount endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { agentAccounts, freightAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerAgentFreightAccountRoutes(app: Express) {
  app.get("/api/agent-accounts", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db.select().from(agentAccounts).where(eq(agentAccounts.companyId, companyId));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/agent-accounts", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { accountId, accountType, accountName } = req.body;
      if (!accountId || !accountType || !accountName)
        return res.status(400).json({ message: "accountId, accountType, and accountName are required" });
      const [row] = await db
        .insert(agentAccounts)
        .values({ companyId, accountId, accountType, accountName })
        .onConflictDoUpdate({
          target: [agentAccounts.companyId, agentAccounts.accountId],
          set: { accountName, accountType },
        })
        .returning();
      res.json(row);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/agent-accounts/:accountId", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = decodeURIComponent(req.params.accountId);
      await db
        .delete(agentAccounts)
        .where(and(eq(agentAccounts.companyId, companyId), eq(agentAccounts.accountId, accountId)));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── FREIGHT ACCOUNTS (Financial Snapshot) ─────────────────────────────────
  app.get("/api/freight-accounts", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db.select().from(freightAccounts).where(eq(freightAccounts.companyId, companyId));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/freight-accounts", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { accountId, accountType, accountName } = req.body;
      if (!accountId || !accountType || !accountName)
        return res.status(400).json({ message: "accountId, accountType, and accountName are required" });
      const [row] = await db
        .insert(freightAccounts)
        .values({ companyId, accountId, accountType, accountName })
        .onConflictDoUpdate({
          target: [freightAccounts.companyId, freightAccounts.accountId],
          set: { accountName, accountType },
        })
        .returning();
      res.json(row);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/freight-accounts/:accountId", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = decodeURIComponent(req.params.accountId);
      await db
        .delete(freightAccounts)
        .where(and(eq(freightAccounts.companyId, companyId), eq(freightAccounts.accountId, accountId)));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
