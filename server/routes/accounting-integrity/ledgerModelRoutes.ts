/**
 * Phase 23 (chart of accounts and general ledger model) routes. Each acts on
 * the session's current company only; the services hold the rules.
 *
 *   GET  /api/accounting/general-ledger?from&to[&kind&ids]          financial report roles, read-only (G18)
 *   GET  /api/accounting/opening-journal/plan?cutOverDate            Owner/Admin, read-only plan (G6)
 *   POST /api/accounting/opening-journal/apply                       Owner, { confirm, planHash, cutOverDate }
 *   GET  /api/accounting/legacy-line-reclassification/plan[?targetLedgerAccountId]  Owner/Admin, read-only plan (G7)
 *   POST /api/accounting/legacy-line-reclassification/apply                    Owner, { confirm, planHash, targetLedgerAccountId? }
 *   POST /api/accounting/legacy-line-reclassification/validate-constraints     Owner, { confirm } (VALIDATE where it passes)
 *   GET  /api/accounting/account-reclassification/plan?sourceAccountIds=1,2&destinationAccountId&date[&deactivateSources]
 *                                                                    Owner/Admin, read-only plan (G5)
 *   POST /api/accounting/account-reclassification/apply              Owner, { confirm, planHash, sourceAccountIds,
 *                                                                    destinationAccountId, date, deactivateSources? }
 *   POST /api/admin/account-migration/execute | /undo                410: retired (G5), registered before the old handlers
 */
import type { Express, Request, Response } from "express";

import { pool } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resolveRequestCompanyId } from "../../services/security/requestCompanyScope";
import { PARTY_BALANCE_KINDS, type BalanceRowKind } from "../../services/accounting/balances/ledgerBalanceEngine";
import { buildPeriodGeneralLedger } from "../../services/accounting/generalLedgerReport";
import {
  OpeningJournalRefusal,
  applyOpeningJournal,
  openingJournalApplication,
  planOpeningJournal,
} from "../../services/accounting/openingJournal";
import {
  LegacyLineRepairRefusal,
  applyLegacyLineRepair,
  planLegacyLineRepair,
  validateLedgerGuardConstraints,
} from "../../services/accounting/legacyLineRepair";
import {
  AccountReclassificationRefusal,
  applyAccountReclassification,
  planAccountReclassification,
  type AccountReclassificationRequest,
} from "../../services/accounting/accountReclassification";
import { requireFinancialReportAccess } from "../stats/financialReportAccess";

const PLAN_HASH = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_KINDS: readonly string[] = [...PARTY_BALANCE_KINDS, "missingAccount", "unassigned"];

export const ACCOUNT_MIGRATION_RETIRED = "ACCOUNT_MIGRATION_RETIRED" as const;
export const ACCOUNT_MIGRATION_RETIRED_MESSAGE =
  "Account migration no longer moves vouchers between companies or rewrites their lines. Move an account's balance with an account reclassification journal (Owner), or between companies with an intercompany transfer.";

const actorOf = (req: Request) => ({
  userId: String(req.session.userId ?? ""),
  username: req.session.username || String(req.session.userId ?? "unknown"),
});

function reviewedHash(req: Request, res: Response): string | null {
  if (req.body?.confirm !== true) {
    res.status(400).json({ message: "Confirmation is required" });
    return null;
  }
  const planHash = req.body?.planHash;
  if (typeof planHash !== "string" || !PLAN_HASH.test(planHash)) {
    res.status(400).json({ message: "The reviewed plan hash is required" });
    return null;
  }
  return planHash;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function idList(value: unknown): number[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return parts.map((part) => positiveId(String(part).trim())).filter((id): id is number => id !== null);
}

function reclassificationRequest(source: Record<string, unknown> | undefined): AccountReclassificationRequest {
  return {
    sourceAccountIds: idList(source?.sourceAccountIds),
    destinationAccountId: positiveId(source?.destinationAccountId) ?? 0,
    date: typeof source?.date === "string" ? source.date : "",
    deactivateSources: source?.deactivateSources === true || source?.deactivateSources === "true",
  };
}

function sendRefusal(res: Response, error: unknown, route: string): void {
  if (
    error instanceof OpeningJournalRefusal ||
    error instanceof LegacyLineRepairRefusal ||
    error instanceof AccountReclassificationRefusal
  ) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  const closed = closedPeriodErrorResponse(error);
  if (closed) {
    res.status(closed.status).json(closed.body);
    return;
  }
  logger.error(`${route} error`, { error });
  res.status(500).json({ message: getErrorMessage(error) });
}

/** Registered before the account migration handlers, so these answer first. */
export function registerAccountMigrationRetirementRoutes(app: Express): void {
  for (const path of ["/api/admin/account-migration/execute", "/api/admin/account-migration/undo"]) {
    app.post(path, requireAuth, requireRole("Admin", "Owner", "Developer"), (_req: Request, res: Response) => {
      res.status(410).json({ code: ACCOUNT_MIGRATION_RETIRED, message: ACCOUNT_MIGRATION_RETIRED_MESSAGE });
    });
  }
}

export function registerLedgerModelRoutes(app: Express): void {
  app.get("/api/accounting/general-ledger", requireAuth, requireFinancialReportAccess, async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const from = String(req.query.from ?? "");
      const to = String(req.query.to ?? "");
      if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
        return res.status(400).json({ message: "from and to (YYYY-MM-DD, from <= to) are required" });
      }
      const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : undefined;
      if (kind && !ROW_KINDS.includes(kind)) return res.status(400).json({ message: "Unknown account kind" });
      const ids = idList(req.query.ids);
      res.json(
        await buildPeriodGeneralLedger({
          companyId,
          from,
          to,
          kind: kind as BalanceRowKind | undefined,
          ids: kind && ids.length > 0 ? ids : undefined,
        })
      );
    } catch (error: unknown) {
      logger.error("GET /api/accounting/general-ledger error", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounting/opening-journal/plan", requireAuth, requireRole("Owner", "Admin"), async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const cutOverDate = typeof req.query.cutOverDate === "string" ? req.query.cutOverDate : null;
      const [plan, applied] = await Promise.all([
        planOpeningJournal(companyId, cutOverDate),
        openingJournalApplication(companyId),
      ]);
      res.json({ ...plan, applied });
    } catch (error: unknown) {
      sendRefusal(res, error, "GET /api/accounting/opening-journal/plan");
    }
  });

  app.post("/api/accounting/opening-journal/apply", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const cutOverDate = typeof req.body?.cutOverDate === "string" ? req.body.cutOverDate : "";
      if (!ISO_DATE.test(cutOverDate)) return res.status(400).json({ message: "A cut-over date is required" });
      const result = await applyOpeningJournal(companyId, { cutOverDate, planHash, actor: actorOf(req) });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      sendRefusal(res, error, "POST /api/accounting/opening-journal/apply");
    }
  });

  app.get(
    "/api/accounting/legacy-line-reclassification/plan",
    requireAuth,
    requireRole("Owner", "Admin"),
    async (req, res) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        res.json(
          await planLegacyLineRepair(companyId, { targetLedgerAccountId: positiveId(req.query.targetLedgerAccountId) })
        );
      } catch (error: unknown) {
        sendRefusal(res, error, "GET /api/accounting/legacy-line-reclassification/plan");
      }
    }
  );

  app.post(
    "/api/accounting/legacy-line-reclassification/apply",
    requireAuth,
    requireRole("Owner"),
    async (req, res) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        const planHash = reviewedHash(req, res);
        if (!planHash) return;
        const result = await applyLegacyLineRepair(companyId, {
          planHash,
          targetLedgerAccountId: positiveId(req.body?.targetLedgerAccountId),
          actor: actorOf(req),
        });
        res.json({ applied: true, ...result });
      } catch (error: unknown) {
        sendRefusal(res, error, "POST /api/accounting/legacy-line-reclassification/apply");
      }
    }
  );

  app.post(
    "/api/accounting/legacy-line-reclassification/validate-constraints",
    requireAuth,
    requireRole("Owner"),
    async (req, res) => {
      try {
        if (req.body?.confirm !== true) return res.status(400).json({ message: "Confirmation is required" });
        res.json({ results: await validateLedgerGuardConstraints(pool) });
      } catch (error: unknown) {
        sendRefusal(res, error, "POST /api/accounting/legacy-line-reclassification/validate-constraints");
      }
    }
  );

  app.get(
    "/api/accounting/account-reclassification/plan",
    requireAuth,
    requireRole("Owner", "Admin"),
    async (req, res) => {
      try {
        const companyId = resolveRequestCompanyId(req);
        res.json(
          await planAccountReclassification(companyId, reclassificationRequest(req.query as Record<string, unknown>))
        );
      } catch (error: unknown) {
        sendRefusal(res, error, "GET /api/accounting/account-reclassification/plan");
      }
    }
  );

  app.post("/api/accounting/account-reclassification/apply", requireAuth, requireRole("Owner"), async (req, res) => {
    try {
      const companyId = resolveRequestCompanyId(req);
      const planHash = reviewedHash(req, res);
      if (!planHash) return;
      const result = await applyAccountReclassification(companyId, {
        ...reclassificationRequest(req.body),
        planHash,
        actor: actorOf(req),
      });
      res.json({ applied: true, ...result });
    } catch (error: unknown) {
      sendRefusal(res, error, "POST /api/accounting/account-reclassification/apply");
    }
  });
}
