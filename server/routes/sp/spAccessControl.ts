import { getErrorDetails } from "@shared/errorUtils";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireSpCompany } from "./spHelpers";
import { resultRows } from "../../lib/queryResult";

export const SP_PERMISSIONS = [
  "sp_view",
  "sp_sales_create",
  "sp_sales_reverse",
  "sp_container_manage",
  "sp_offload",
  "sp_offload_reverse",
  "sp_owner_withdrawal",
  "sp_opening_stock",
  "sp_reports",
  "sp_setup",
  "sp_migration",
] as const;

type SpPermission = (typeof SP_PERMISSIONS)[number];

const ROLE_DEFAULTS: Record<string, readonly SpPermission[]> = {
  Developer: SP_PERMISSIONS,
  Admin: SP_PERMISSIONS,
  Owner: [
    "sp_view",
    "sp_sales_create",
    "sp_container_manage",
    "sp_offload",
    "sp_owner_withdrawal",
    "sp_opening_stock",
    "sp_reports",
  ],
  Manager: ["sp_view", "sp_sales_create", "sp_container_manage", "sp_offload", "sp_reports"],
  POS: ["sp_view", "sp_sales_create"],
  "View Only": ["sp_view", "sp_reports"],
};

let storageReady: Promise<void> | null = null;
export function ensureSpAccessControlStorage(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sp_permission_grants (
          id bigserial PRIMARY KEY,
          company_id integer NOT NULL,
          user_id text NOT NULL,
          permission varchar(64) NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          granted_by text,
          granted_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (company_id, user_id, permission)
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sp_audit_events (
          id bigserial PRIMARY KEY,
          company_id integer NOT NULL,
          user_id text,
          username text,
          role varchar(64),
          permission varchar(64) NOT NULL,
          action varchar(120) NOT NULL,
          method varchar(12) NOT NULL,
          path text NOT NULL,
          entity_id text,
          reason text,
          confirmation text,
          idempotency_key text,
          status_code integer,
          request_body jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS sp_idempotency_keys (
          id bigserial PRIMARY KEY,
          company_id integer NOT NULL,
          user_id text NOT NULL,
          permission varchar(64) NOT NULL,
          idempotency_key varchar(200) NOT NULL,
          method varchar(12) NOT NULL,
          path text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (company_id, user_id, permission, idempotency_key)
        )
      `);
      await db.execute(
        sql`CREATE INDEX IF NOT EXISTS sp_audit_events_company_created_idx ON sp_audit_events(company_id, created_at DESC)`
      );
    })().catch((error) => {
      storageReady = null;
      throw error;
    });
  }
  return storageReady;
}

function classifyPermission(req: Request): SpPermission {
  const path = req.path;
  const method = req.method.toUpperCase();
  if (
    path.includes("migration") ||
    path.includes("cutover") ||
    path.includes("final-verification") ||
    path.startsWith("/production/")
  )
    return "sp_migration";
  if (path.includes("setup")) return "sp_setup";
  if (path.includes("opening-stock")) return "sp_opening_stock";
  if (path === "/golden-coast/phase9/hassan-savings-withdrawal" && method === "POST") return "sp_owner_withdrawal";
  // Settling GC Sales Cash from equity moves partner capital, so it must be
  // classified before the generic sales rule below: the path contains "sales",
  // which would otherwise grant it to any sales-entry user via sp_sales_create.
  if (path === "/golden-coast/equity-sales-cash-settlement" && method === "POST") return "sp_owner_withdrawal";
  if (
    path.includes("/report/") ||
    path.includes("/export") ||
    path.includes("reconciliation") ||
    path.includes("profit-splits")
  )
    return "sp_reports";
  if (path.includes("/sales/") && path.endsWith("/reverse")) return "sp_sales_reverse";
  if (path.includes("offload") && path.endsWith("/reverse")) return "sp_offload_reverse";
  if ((path === "/offload" || path === "/golden-coast/phase8/offload") && method === "POST") return "sp_offload";
  if (path.includes("container") && method !== "GET") return "sp_container_manage";
  if ((path.includes("sales") || path.includes("sale")) && method !== "GET") return "sp_sales_create";
  return "sp_view";
}

function sensitiveRequirement(req: Request): { confirmation: string; requireReason: boolean } | null {
  const path = req.path;
  if (path === "/production/evidence" && req.method === "POST")
    return { confirmation: "RECORD SP PRODUCTION EVIDENCE", requireReason: true };
  if (path === "/production/close-rollback-window" && req.method === "POST")
    return { confirmation: "CLOSE SP ROLLBACK WINDOW", requireReason: true };
  if (path.includes("/sales/") && path.endsWith("/reverse"))
    return { confirmation: "REVERSE SP SALE", requireReason: true };
  if (path.includes("/containers/") && path.endsWith("/cancel"))
    return { confirmation: "CANCEL SP CONTAINER", requireReason: true };
  if (path.includes("offload") && path.endsWith("/reverse"))
    return { confirmation: "REVERSE SP OFFLOAD", requireReason: true };
  if (path.includes("opening-stock") && req.method !== "GET")
    return { confirmation: "POST SP OPENING STOCK", requireReason: true };
  if (path.includes("profit-splits") && req.method === "POST")
    return { confirmation: "FINALIZE SP PROFIT SPLIT", requireReason: true };
  if ((path.includes("migration") || path.includes("cutover")) && req.method !== "GET")
    return { confirmation: "RUN SP MIGRATION", requireReason: true };
  if (path.includes("setup") && req.method !== "GET") return { confirmation: "CHANGE SP SETUP", requireReason: true };
  return null;
}

function sanitizedBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    if (/password|secret|token/i.test(key)) copy[key] = "[REDACTED]";
  }
  return copy;
}

async function hasPermission(
  companyId: number,
  userId: string,
  role: string,
  permission: SpPermission
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT enabled
    FROM sp_permission_grants
    WHERE company_id = ${companyId} AND user_id = ${userId} AND permission = ${permission}
    LIMIT 1
  `);
  const row = (resultRows(result) ?? [])[0];
  if (row) return row.enabled === true;
  return (ROLE_DEFAULTS[role] ?? []).includes(permission);
}

async function enforceSpAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    await ensureSpAccessControlStorage();

    const permission = classifyPermission(req);
    const userId = String(req.user?.id ?? req.session.userId ?? "");
    const role = String(req.user?.role ?? req.session.currentRole ?? "");
    if (!userId || !(await hasPermission(companyId, userId, role, permission))) {
      await db.execute(sql`
        INSERT INTO sp_audit_events(company_id, user_id, username, role, permission, action, method, path, status_code, request_body)
        VALUES (${companyId}, ${userId || null}, ${req.session.username ?? null}, ${role || null}, ${permission}, 'ACCESS_DENIED', ${req.method}, ${req.originalUrl}, 403, ${JSON.stringify(sanitizedBody(req.body))}::jsonb)
      `);
      res.status(403).json({
        code: "SP_PERMISSION_DENIED",
        message: releaseDebtEnglish(`Missing Supplier Partner permission: ${permission}`),
      });
      return;
    }

    const sensitive = sensitiveRequirement(req);
    const reason = String(req.body?.reason ?? "").trim();
    const confirmation = String(req.body?.confirmation ?? "").trim();
    let idempotencyKey: string | null = null;
    if (sensitive) {
      if (confirmation !== sensitive.confirmation) {
        res.status(400).json({
          code: "SP_EXACT_CONFIRMATION_REQUIRED",
          message: releaseDebtEnglish(`Type exactly: ${sensitive.confirmation}`),
        });
        return;
      }
      if (sensitive.requireReason && reason.length < 5) {
        res.status(400).json({
          code: "SP_REASON_REQUIRED",
          message: releaseDebtEnglish("A meaningful reason of at least 5 characters is required."),
        });
        return;
      }
      idempotencyKey = String(req.header("Idempotency-Key") ?? req.body?.idempotencyKey ?? "").trim();
      if (!idempotencyKey) {
        res.status(400).json({
          code: "SP_IDEMPOTENCY_KEY_REQUIRED",
          message: releaseDebtEnglish("Idempotency-Key is required for this sensitive action."),
        });
        return;
      }
      try {
        await db.execute(sql`
          INSERT INTO sp_idempotency_keys(company_id, user_id, permission, idempotency_key, method, path)
          VALUES (${companyId}, ${userId}, ${permission}, ${idempotencyKey}, ${req.method}, ${req.originalUrl})
        `);
      } catch (error) {
        if (getErrorDetails(error).code === "23505") {
          res.status(409).json({
            code: "SP_DUPLICATE_REQUEST",
            message: releaseDebtEnglish("This sensitive request has already been submitted."),
          });
          return;
        }
        throw error;
      }
    }

    res.once("finish", () => {
      void db
        .execute(
          sql`
        INSERT INTO sp_audit_events(
          company_id, user_id, username, role, permission, action, method, path, entity_id,
          reason, confirmation, idempotency_key, status_code, request_body
        ) VALUES (
          ${companyId}, ${userId}, ${req.session.username ?? null}, ${role}, ${permission},
          ${req.method === "GET" ? "READ" : "WRITE"}, ${req.method}, ${req.originalUrl},
          ${req.params?.id ?? req.body?.id ?? req.body?.containerId ?? req.body?.cutoverId ?? null}, ${reason || null},
          ${confirmation || null}, ${idempotencyKey}, ${res.statusCode}, ${JSON.stringify(sanitizedBody(req.body))}::jsonb
        )
      `
        )
        .catch((error) => logger.error("SP audit event write failed", { error }));
      if (sensitive && res.statusCode >= 400 && idempotencyKey) {
        void db
          .execute(
            sql`
          DELETE FROM sp_idempotency_keys
          WHERE company_id = ${companyId} AND user_id = ${userId}
            AND permission = ${permission} AND idempotency_key = ${idempotencyKey}
        `
          )
          .catch((error) => logger.error("SP idempotency rollback failed", { error }));
      }
    });

    next();
  } catch (error: unknown) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpAccessControl(app: Express): void {
  app.use("/api/sp", requireAuth, (req, res, next) => {
    void enforceSpAccess(req, res, next);
  });
}
