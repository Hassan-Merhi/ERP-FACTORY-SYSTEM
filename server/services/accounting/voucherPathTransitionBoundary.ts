import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";

import { requireAuth } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { replayAuthorizationContext } from "./replayAuthorizationContext";
import {
  isPhase5OperationalVoucherRequest,
  isPhase6DeterministicSpecialRequest,
  isVoucherRequestPayload,
  phase6DeterministicSourcePrefix,
  type VoucherRequestPayload,
} from "@shared/voucherPathIdentityPolicy";

type GuardRow = {
  id: number | string;
  request_fingerprint: string;
  state: "processing" | "completed";
  response_status: number | null;
  response_body: unknown;
};

export type VoucherPathClaimResult =
  { kind: "owner" } | { kind: "replay"; status: number; body: unknown } | { kind: "conflict" } | { kind: "uncertain" };

let ensureTablePromise: Promise<void> | null = null;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "clientRequestId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function normalizedPath(req: Request): string {
  return (req.path || req.originalUrl || "").split("?")[0];
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVoucherPathCompanyId(req: Request): number | null {
  if (!req.session?.userId) return null;
  const path = normalizedPath(req);
  const body = isVoucherRequestPayload(req.body) ? req.body : {};

  if (path === "/api/sp/migration/opening-balance") {
    return positiveInteger(body.targetCompanyId);
  }

  const requestCompanyId = positiveInteger(body.companyId);
  if (requestCompanyId) return requestCompanyId;

  if (path.startsWith("/api/factory/")) {
    return positiveInteger(req.session.factoryCompanyId) ?? positiveInteger(req.session.currentCompanyId);
  }
  return positiveInteger(req.session.currentCompanyId);
}

function phase5RequestIdentity(req: Request, body: VoucherRequestPayload): string | null {
  const header = req.get("X-Idempotency-Key")?.trim();
  if (header) return header;
  const fromBody = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
  return fromBody || null;
}

export function deterministicPhase6RequestIdentity(
  method: string,
  pathname: string,
  companyId: number,
  body: VoucherRequestPayload
): string | null {
  const prefix = phase6DeterministicSourcePrefix(method, pathname);
  if (!prefix) return null;
  const explicitRunId =
    typeof body.sourceRunId === "string" && body.sourceRunId.trim()
      ? body.sourceRunId.trim()
      : typeof body.importBatchId === "string" && body.importBatchId.trim()
        ? body.importBatchId.trim()
        : null;
  const source = explicitRunId || sha256({ method: method.toUpperCase(), pathname, body });
  return `${prefix}:${companyId}:${source}`;
}

export function voucherPathRequestFingerprint(
  method: string,
  pathname: string,
  body: VoucherRequestPayload,
  authorization?: unknown
): string {
  return sha256({ method: method.toUpperCase(), pathname, body, authorization: authorization ?? null });
}

export async function ensureVoucherPathGuardTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS voucher_path_request_guards (
          id BIGSERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_kind TEXT NOT NULL,
          request_path TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'processing',
          response_status INTEGER,
          response_body JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT voucher_path_request_guards_state_check CHECK (state IN ('processing', 'completed')),
          CONSTRAINT voucher_path_request_guards_company_key_unique UNIQUE (company_id, idempotency_key)
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS voucher_path_request_guards_lookup_idx
        ON voucher_path_request_guards (company_id, idempotency_key, state)
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}

async function readGuard(companyId: number, idempotencyKey: string): Promise<GuardRow | null> {
  const result = await db.execute(sql`
    SELECT id, request_fingerprint, state, response_status, response_body
    FROM voucher_path_request_guards
    WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  return (result.rows[0] as GuardRow | undefined) ?? null;
}

async function waitForCompletion(
  companyId: number,
  idempotencyKey: string,
  fingerprint: string
): Promise<VoucherPathClaimResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await readGuard(companyId, idempotencyKey);
    if (!row) return { kind: "uncertain" };
    if (row.request_fingerprint !== fingerprint) return { kind: "conflict" };
    if (row.state === "completed" && row.response_status !== null) {
      return { kind: "replay", status: row.response_status, body: row.response_body };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { kind: "uncertain" };
}

export async function claimVoucherPathRequest(
  companyId: number,
  idempotencyKey: string,
  requestKind: "operational" | "deterministic-source",
  pathname: string,
  fingerprint: string
): Promise<VoucherPathClaimResult> {
  await ensureVoucherPathGuardTable();

  const inserted = await db.execute(sql`
    INSERT INTO voucher_path_request_guards
      (company_id, idempotency_key, request_kind, request_path, request_fingerprint, state)
    VALUES
      (${companyId}, ${idempotencyKey}, ${requestKind}, ${pathname}, ${fingerprint}, 'processing')
    ON CONFLICT (company_id, idempotency_key) DO NOTHING
    RETURNING id
  `);
  if (inserted.rows.length > 0) return { kind: "owner" };

  const existing = await readGuard(companyId, idempotencyKey);
  if (!existing) return { kind: "uncertain" };
  if (existing.request_fingerprint !== fingerprint) return { kind: "conflict" };
  if (existing.state === "completed" && existing.response_status !== null) {
    return { kind: "replay", status: existing.response_status, body: existing.response_body };
  }
  return waitForCompletion(companyId, idempotencyKey, fingerprint);
}

export async function completeVoucherPathRequest(
  companyId: number,
  idempotencyKey: string,
  status: number,
  body: unknown,
  deterministicSource: boolean,
  importFailureRecovery?: { pathname: string; requestId: string | null; fingerprint: string }
): Promise<void> {
  if (deterministicSource && status >= 400 && status < 500) {
    await db.execute(sql`
      DELETE FROM voucher_path_request_guards
      WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey} AND state = 'processing'
    `);
    return;
  }

  if (status >= 500) {
    // The handler has already returned its error response (and completed any
    // awaited transaction rollback). A failed import must not strand its batch
    // forever when there is provably no committed voucher. Never release a
    // guard if the posting outcome cannot be verified.
    if (importFailureRecovery) {
      const { pathname, requestId, fingerprint } = importFailureRecovery;
      const sourceType = pathname === "/api/credit-sales-import/import"
        ? "credit-sales-import"
        : pathname === "/api/pos-import/import"
          ? "pos-import"
          : null;
      if (sourceType && requestId) {
        const postingKey = `${sourceType}:${companyId}:${requestId}`;
        const posted = await db.execute(sql`
          SELECT 1
          FROM accounting_posting_requests
          WHERE company_id = ${companyId} AND idempotency_key = ${postingKey}
          LIMIT 1
        `);
        if (posted.rows.length === 0) {
          await db.execute(sql`
            DELETE FROM voucher_path_request_guards
            WHERE company_id = ${companyId}
              AND idempotency_key = ${idempotencyKey}
              AND request_fingerprint = ${fingerprint}
              AND state = 'processing'
          `);
          logger.warn("Unblocked failed POS import with no committed voucher", {
            module: "voucher-path-request-boundary",
            path: pathname,
            companyId,
          });
        }
      }
    }
    return;
  }

  const responseJson = JSON.stringify(body ?? null);
  await db.execute(sql`
    UPDATE voucher_path_request_guards
    SET state = 'completed', response_status = ${status}, response_body = ${responseJson}::jsonb,
        updated_at = NOW()
    WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey} AND state = 'processing'
  `);
}

export function captureResponse(res: Response): { read: () => unknown } {
  let body: unknown = null;
  let capturedStructuredBody = false;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((value: unknown) => {
    body = value;
    capturedStructuredBody = true;
    return originalJson(value);
  }) as Response["json"];

  res.send = ((value: unknown) => {
    // res.json() serializes and then delegates to res.send(), so without this
    // guard the string overwrites the structured value json() just captured and
    // the stored replay becomes a JSON-encoded string of the response rather
    // than the response itself. A caller retrying the request would then get a
    // string where the original returned an object.
    if (!capturedStructuredBody) body = value;
    return originalSend(value as never);
  }) as Response["send"];

  return { read: () => body };
}

async function voucherPathPhase5to6Boundary(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pathname = normalizedPath(req);
  const phase5 = isPhase5OperationalVoucherRequest(req.method, pathname);
  const phase6 = isPhase6DeterministicSpecialRequest(req.method, pathname);
  if (!phase5 && !phase6) {
    next();
    return;
  }

  const companyId = resolveVoucherPathCompanyId(req);
  if (!companyId) {
    next();
    return;
  }

  const body = isVoucherRequestPayload(req.body) ? req.body : {};
  const idempotencyKey = phase6
    ? deterministicPhase6RequestIdentity(req.method, pathname, companyId, body)
    : phase5RequestIdentity(req, body);

  if (!idempotencyKey) {
    res.status(400).json({
      code: "ACCOUNTING_REQUEST_ID_REQUIRED",
      message: "A stable request identity is required for this accounting operation.",
    });
    return;
  }

  const fingerprint = voucherPathRequestFingerprint(req.method, pathname, body, replayAuthorizationContext(req));
  let claim: VoucherPathClaimResult;
  try {
    claim = await claimVoucherPathRequest(
      companyId,
      idempotencyKey,
      phase6 ? "deterministic-source" : "operational",
      pathname,
      fingerprint
    );
  } catch (error) {
    logger.error("Voucher request boundary claim failed", {
      module: "voucher-path-request-boundary",
      path: pathname,
      companyId,
      error,
    });
    res.status(503).json({
      code: "ACCOUNTING_REQUEST_GUARD_UNAVAILABLE",
      message: "Accounting request protection is temporarily unavailable. The operation was not started.",
    });
    return;
  }

  if (claim.kind === "conflict") {
    res.status(409).json({
      code: "POSTING_IDEMPOTENCY_CONFLICT",
      message: "This request identity was already used for different accounting data or authorization context.",
    });
    return;
  }
  if (claim.kind === "uncertain") {
    res.status(409).json({
      code: "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN",
      message: "The original accounting request may still have completed. Reconcile its result before retrying.",
    });
    return;
  }
  if (claim.kind === "replay") {
    res.status(claim.status).json(claim.body ?? null);
    return;
  }

  const captured = captureResponse(res);
  res.on("finish", () => {
    void completeVoucherPathRequest(
      companyId,
      idempotencyKey,
      res.statusCode,
      captured.read(),
      phase6,
      phase6 ? { pathname, requestId: phase5RequestIdentity(req, body), fingerprint } : undefined
    ).catch(
      (error) => {
        logger.error("Voucher request boundary completion persistence failed", {
          module: "voucher-path-request-boundary",
          path: pathname,
          companyId,
          error,
        });
      }
    );
  });
  next();
}

export function registerVoucherPathPhase5to6Boundary(app: Express): void {
  app.use((req, res, next) => {
    const pathname = normalizedPath(req);
    if (
      !isPhase5OperationalVoucherRequest(req.method, pathname) &&
      !isPhase6DeterministicSpecialRequest(req.method, pathname)
    ) {
      next();
      return;
    }

    void requireAuth(req, res, (authError?: unknown) => {
      if (authError) {
        next(authError);
        return;
      }
      void voucherPathPhase5to6Boundary(req, res, next).catch(next);
    });
  });
}
