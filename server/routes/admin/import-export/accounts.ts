/**
 * importExportRoutes: AgentFreightAccount endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { requireFactoryPageAccess } from "../../../lib/factoryAccessControl";
import { agentAccounts, freightAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";

// The handlers keep their own "accountId, accountType, and accountName are required" check.
// The Agent Ledger page sends its numeric account id; the snapshot page sends a string.
const pinAccountInput = {
  query: emptyQuery,
  body: z.strictObject({
    accountId: z.union([z.string(), z.number()]).optional(),
    accountType: z.string().optional(),
    accountName: z.string().optional(),
  }),
} satisfies RequestSchemas;
const unpinAccountInput = {
  params: z.strictObject({ accountId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerAgentFreightAccountRoutes(app: Express) {
  const factoryAgentGuard = requireFactoryPageAccess("factory/agents");
  const requireFactoryAgentIfNeeded: RequestHandler = (req, res, next) => {
    if (req.path.toLowerCase().startsWith("/api/factory/agents/")) {
      return factoryAgentGuard(req, res, next);
    }
    next();
  };
  const agentCompanyId = (req: Request) =>
    req.path.toLowerCase().startsWith("/api/factory/agents/")
      ? req.session.factoryCompanyId || req.session.currentCompanyId
      : req.session.currentCompanyId || req.session.factoryCompanyId;

  const readPinnedAgents = async (req: Request, res: Response) => {
    try {
      const companyId = agentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db.select().from(agentAccounts).where(eq(agentAccounts.companyId, companyId));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.get("/api/agent-accounts", requireAuth, (req, res) => readPinnedAgents(req, res));
  app.get("/api/factory/agents/pinned", requireAuth, requireFactoryAgentIfNeeded, readPinnedAgents);

  const addPinnedAgent = async (req: Request, res: Response) => {
    try {
      const companyId = agentCompanyId(req);
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
  };
  app.post("/api/agent-accounts", requireAuth, validateRequest(pinAccountInput), (req, res) =>
    addPinnedAgent(req, res)
  );
  app.post(
    "/api/factory/agents/pinned",
    requireAuth,
    requireFactoryAgentIfNeeded,
    validateRequest(pinAccountInput),
    addPinnedAgent
  );

  const removePinnedAgent = async (req: Request, res: Response) => {
    try {
      const companyId = agentCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = decodeURIComponent(req.params.accountId);
      await db
        .delete(agentAccounts)
        .where(and(eq(agentAccounts.companyId, companyId), eq(agentAccounts.accountId, accountId)));
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  };
  app.delete("/api/agent-accounts/:accountId", requireAuth, validateRequest(unpinAccountInput), (req, res) =>
    removePinnedAgent(req, res)
  );
  app.delete(
    "/api/factory/agents/pinned/:accountId",
    requireAuth,
    requireFactoryAgentIfNeeded,
    validateRequest(unpinAccountInput),
    removePinnedAgent
  );

  // ── FREIGHT ACCOUNTS (Financial Snapshot) ─────────────────────────────────
  app.get(
    "/api/freight-accounts",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const rows = await db.select().from(freightAccounts).where(eq(freightAccounts.companyId, companyId));
        res.json(rows);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/freight-accounts",
    requireAuth,
    validateRequest(pinAccountInput),
    async (req: import("express").Request, res: import("express").Response) => {
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
    }
  );

  app.delete(
    "/api/freight-accounts/:accountId",
    requireAuth,
    validateRequest(unpinAccountInput),
    async (req: import("express").Request, res: import("express").Response) => {
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
    }
  );
}
