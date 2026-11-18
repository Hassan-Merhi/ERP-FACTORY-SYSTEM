// Extracted from ./spMigrationSetupRoutes.ts
import type { Express, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import {
  SP_ACCOUNTS,
  ALL_ACCOUNT_DEFS,
  getCompanyRow,
  logRun,
  trackRow,
  ensureSpAccounts,
  ensureGcProfitAccounts,
  buildGcMigrationPreview,
} from "./_helpers";

export function registerSpMigrationSetupRoutesPart1(app: Express) {
  // ── GET /api/sp/migration/gc-preview ─────────────────────────────────────
  // Canonical read-only preview for the staged GC migration flow. Developer-only,
  // no writes. See buildGcMigrationPreview for the exact response shape.
  app.get(
    "/api/sp/migration/gc-preview",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const sourceId = parseInt(String(req.query.sourceCompanyId ?? ""), 10);
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);

        if (!sourceId || !targetId)
          return res.status(400).json({ message: "sourceCompanyId and targetCompanyId are required" });
        if (sourceId === targetId) return res.status(400).json({ message: "Source and target must be different" });

        const { status, body } = await buildGcMigrationPreview(sourceId, targetId);
        return res.status(status).json(body);
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-preview error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/gc-rehearsal ──────────────────────────────────
  // Full GC-LSHI → SP migration:
  //   1. Standard SP accounts (10 accounts)
  //   2. GC profit accounts (2 accounts)
  //   3. Stock items + aliases (same as rehearsal)
  //   4. Sale vouchers from ERP → SP (with account remapping)
  // ── DISABLED: old all-in-one GC migration flow ──────────────────────────
  // The single-shot "run everything" flow has been superseded by the staged
  // migration steps (stock master -> stock opening -> sales read-only ->
  // containers -> profit-share opening -> reconciliation). It is kept only as
  // a hard-disabled stub so any stale client cannot silently trigger it.
  app.post(
    "/api/sp/migration/gc-rehearsal",
    requireAuth,
    requireRole("Developer"),
    async (_req: unknown, res: import("express").Response) => {
      return res.status(410).json({
        message: "The old all-in-one GC migration flow is disabled. Use the staged migration steps instead.",
        code: "GC_REHEARSAL_DISABLED",
      });
    }
  );

  // ── GET /api/sp/migration/gc-account-plan ────────────────────────────────
  // Returns the full proposed chart-of-accounts list (SP + GC profit accounts)
  // with default code/name so the UI can let the user rename before creation.
  app.get(
    "/api/sp/migration/gc-account-plan",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const targetId = parseInt(String(req.query.targetCompanyId ?? ""), 10);
        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });

        const existingRows = (
          await db.execute(sql`
        SELECT sub_type, code, name FROM ledger_accounts
        WHERE company_id = ${targetId} AND deleted_at IS NULL
          AND sub_type = ANY(${sqlArray(ALL_ACCOUNT_DEFS.map((a) => a.subType))})
      `)
        ).rows;
        const existingBySubType = new Map(existingRows.map((r) => [r.sub_type, r]));

        const accounts = ALL_ACCOUNT_DEFS.map((a) => {
          const existing = existingBySubType.get(a.subType);
          return {
            subType: a.subType,
            accountType: a.accountType,
            defaultCode: a.code,
            defaultName: a.name,
            exists: !!existing,
            currentCode: existing?.code ?? a.code,
            currentName: existing?.name ?? a.name,
            group: SP_ACCOUNTS.some((s) => s.subType === a.subType) ? "sp" : "gc",
          };
        });

        return res.json({ accounts });
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-account-plan error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── POST /api/sp/migration/gc-create-accounts ────────────────────────────
  // Creates only the missing accounts from the whitelist, using user-supplied
  // code/name overrides. Idempotent — existing subTypes are left untouched.
  app.post(
    "/api/sp/migration/gc-create-accounts",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      try {
        const { targetCompanyId, accounts } = req.body ?? {};
        const targetId = parseInt(String(targetCompanyId ?? ""), 10);
        if (!targetId) return res.status(400).json({ message: "targetCompanyId is required" });
        if (!Array.isArray(accounts) || !accounts.length) {
          return res.status(400).json({ message: "accounts array is required" });
        }

        const targetComp = await getCompanyRow(targetId);
        if (!targetComp) return res.status(404).json({ message: "Target company not found" });
        if (targetComp.company_type !== "supplier_partner") {
          return res.status(400).json({ message: "Target must be a supplier_partner company" });
        }

        const allowedSubTypes = new Set(ALL_ACCOUNT_DEFS.map((a) => a.subType));
        const overrides: Record<string, { code?: string; name?: string }> = {};
        for (const a of accounts) {
          if (!allowedSubTypes.has(a?.subType)) {
            return res.status(400).json({ message: `Unknown account subType: ${a?.subType}` });
          }
          overrides[a.subType] = { code: a.code, name: a.name };
        }

        const runId = await logRun(
          targetId,
          targetId,
          "gc_create_accounts",
          "running",
          0,
          null,
          `User: ${req.session?.userId ?? "unknown"} | Target: ${targetComp.name}`
        );

        const spResult = await ensureSpAccounts(targetId, overrides);
        const gcResult = await ensureGcProfitAccounts(targetId, overrides);
        const allNewIds = [...spResult.newIds, ...gcResult.newIds];
        for (const id of allNewIds) await trackRow(runId, "ledger_accounts", id);

        await db.execute(sql`
          UPDATE sp_migration_rehearsal_runs
          SET status = 'completed', rows_created = ${allNewIds.length}, completed_at = now()
          WHERE id = ${runId}
        `);

        return res.json({
          success: true,
          runId,
          created: [...spResult.names, ...gcResult.names],
          createdCount: allNewIds.length,
        });
      } catch (err: unknown) {
        logger.error("[SP Migration] gc-create-accounts error:", { error: err });
        return res.status(500).json({ message: "Internal server error" });
      }
    }
  );

  // ── GET /api/sp/migration/session-role ──────────────────────────────────
  // Returns the current session's role — used by the frontend to gate the page.
  app.get(
    "/api/sp/migration/session-role",
    requireAuth,
    requireRole("Developer"),
    async (req: Request, res: Response) => {
      return res.json({ role: req.session?.currentRole ?? null });
    }
  );
}
