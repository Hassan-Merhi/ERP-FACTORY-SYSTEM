import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";

import { requireAuth } from "../../auth";
import { db } from "../../db";
import { replayAuthorizationContext } from "./replayAuthorizationContext";

const REQUEST_KEY_MAX = 180;
const CONCURRENT_REPLAY_WAIT_MS = 15_000;
const CONCURRENT_REPLAY_POLL_MS = 50;

const PHASE4_OPERATIONAL_POST_PATHS = new Set([
  "/api/vouchers",
  "/api/vouchers/with-entries",
  "/api/vouchers/journal",
  "/api/vouchers/journal-entries",
  "/api/vouchers/payment-receipt",
  "/api/salary-advances",
  "/api/payroll/bonus-employee",
  "/api/payroll/bulk-bonus-employees",
  "/api/payroll/bulk-withdraw-employees",
  "/api/payroll/deposit-employee",
  "/api/payroll/bulk-deposit-employees",
  "/api/payroll/withdraw-employee",
  "/api/payroll/pay-worker",
  "/api/payroll/bulk-pay-workers",
  "/api/factory/employees/bulk-payroll",
  "/api/factory/employees/bulk-withdraw",
  "/api/factory/employee-bonuses",
  "/api/factory/pos/sale",
  "/api/factory/supplier-payments",
  "/api/factory/advances/cash-adjustment",
  "/api/factory/advances/repay-by-month",
  "/api/factory/advances/post-repayment-vouchers",
  "/api/factory/payrolls/mark-paid-bulk",
]);

type JsonRecord = Record<string, unknown>;

type StoredOperationalRequest = {
  requestPath: string;
  requestFingerprint: string;
  state: string;
  responseStatus: number | null;
  responseBody: unknown;
};

let ensureTablePromise: Promise<void> | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (isRecord(result) && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== "clientRequestId")
      .map((key) => [key, canonicalize(value[key])])
  );
}

function requestFingerprint(req: Request): string {
  const payload = {
    method: req.method.toUpperCase(),
    path: req.path,
    body: canonicalize(req.body),
    authorization: replayAuthorizationContext(req),
  };
  const serialized = JSON.stringify(payload) ?? "null";
  return createHash("sha256").update(serialized).digest("hex");
}

function requestIdentity(req: Request): string | null {
  const fromHeader = req.get("x-idempotency-key");
  if (fromHeader?.trim()) return fromHeader.trim();
  if (isRecord(req.body) && typeof req.body.clientRequestId === "string" && req.body.clientRequestId.trim()) {
    return req.body.clientRequestId.trim();
  }
  return null;
}

function isOptionalVoucherRequest(req: Request): boolean {
  if (!isRecord(req.body)) return false;
  if (req.path === "/api/vouchers/with-entries") {
    return isRecord(req.body.voucher) && req.body.voucher.optional === true;
  }
  if (
    req.path === "/api/vouchers" ||
    req.path === "/api/vouchers/journal" ||
    req.path === "/api/vouchers/journal-entries" ||
    req.path === "/api/vouchers/payment-receipt"
  ) {
    return req.body.optional === true;
  }
  return false;
}

export function isPhase4OperationalVoucherRequest(method: string, pathname: string, body?: unknown): boolean {
  const verb = method.toUpperCase();

  if (verb === "POST") {
    if (PHASE4_OPERATIONAL_POST_PATHS.has(pathname)) return true;
    if (/^\/api\/factory\/employees\/[^/]+\/(?:deposit|withdraw)$/.test(pathname)) return true;
    if (/^\/api\/factory\/worker-bonuses\/[^/]+\/pay$/.test(pathname)) return true;
    if (/^\/api\/factory\/workers\/[^/]+\/bulk-repay-advances$/.test(pathname)) return true;
    if (/^\/api\/factory\/advances\/[^/]+\/repayments$/.test(pathname)) return true;
    return false;
  }

  if (verb === "PATCH") {
    if (/^\/api\/payroll\/runs\/[^/]+$/.test(pathname)) {
      return isRecord(body) && body.action === "pay";
    }
    if (/^\/api\/factory\/payrolls\/[^/]+\/(?:mark-paid|fix-accounting)$/.test(pathname)) return true;
  }

  return false;
}

export function resolvePhase4OperationalVoucherCompanyId(req: Request): number | null {
  if (!req.session.userId) return null;

  const selectedCompanyId = req.path.startsWith("/api/factory/")
    ? req.session.factoryCompanyId || req.session.currentCompanyId
    : req.session.currentCompanyId;
  const companyId = Number(selectedCompanyId);
  return Number.isSafeInteger(companyId) && companyId > 0 ? companyId : null;
}

async function ensureOperationalVoucherRequestTable(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS operational_voucher_requests (
          id BIGSERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL,
          idempotency_key VARCHAR(180) NOT NULL,
          request_path TEXT NOT NULL,
          request_fingerprint VARCHAR(64) NOT NULL,
          state VARCHAR(20) NOT NULL DEFAULT 'processing',
          response_status INTEGER,
          response_body JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          CONSTRAINT operational_voucher_requests_company_key_unique
            UNIQUE (company_id, idempotency_key)
        )
      `);
      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS operational_voucher_requests_state_idx
          ON operational_voucher_requests (company_id, state, created_at)
      `);
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  return ensureTablePromise;
}

async function loadStoredRequest(companyId: number, idempotencyKey: string): Promise<StoredOperationalRequest | null> {
  const result = await db.execute(sql`
    SELECT
      request_path AS "requestPath",
      request_fingerprint AS "requestFingerprint",
      state,
      response_status AS "responseStatus",
      response_body AS "responseBody"
    FROM operational_voucher_requests
    WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  return rowsFromExecute<StoredOperationalRequest>(result)[0] ?? null;
}

async function claimRequest(
  companyId: number,
  idempotencyKey: string,
  pathname: string,
  fingerprint: string
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO operational_voucher_requests (
      company_id, idempotency_key, request_path, request_fingerprint, state
    )
    VALUES (${companyId}, ${idempotencyKey}, ${pathname}, ${fingerprint}, 'processing')
    ON CONFLICT (company_id, idempotency_key) DO NOTHING
    RETURNING id
  `);
  return rowsFromExecute<{ id: number }>(result).length === 1;
}

async function storeResponse(
  companyId: number,
  idempotencyKey: string,
  responseStatus: number,
  responseBody: unknown
): Promise<void> {
  const serialized = JSON.stringify(responseBody ?? null) ?? "null";
  await db.execute(sql`
    UPDATE operational_voucher_requests
    SET
      state = 'completed',
      response_status = ${responseStatus},
      response_body = CAST(${serialized} AS jsonb),
      completed_at = NOW()
    WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey}
  `);
}

async function waitForCompletedRequest(
  companyId: number,
  idempotencyKey: string
): Promise<StoredOperationalRequest | null> {
  const deadline = Date.now() + CONCURRENT_REPLAY_WAIT_MS;
  while (Date.now() < deadline) {
    const stored = await loadStoredRequest(companyId, idempotencyKey);
    if (!stored || stored.state === "completed") return stored;
    await new Promise((resolve) => setTimeout(resolve, CONCURRENT_REPLAY_POLL_MS));
  }
  return loadStoredRequest(companyId, idempotencyKey);
}

function replayResponseBody(body: unknown): unknown {
  if (!isRecord(body) || typeof body.replayed !== "boolean") return body ?? null;
  return { ...body, replayed: true };
}

function sendStoredResponse(res: Response, stored: StoredOperationalRequest): Response {
  res.setHeader("X-Idempotent-Replay", "true");
  const status = stored.responseStatus ?? 200;
  return res.status(status).json(replayResponseBody(stored.responseBody));
}

async function operationalVoucherBoundary(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = resolvePhase4OperationalVoucherCompanyId(req);
  if (!companyId) {
    next();
    return;
  }

  const idempotencyKey = requestIdentity(req);
  if (!idempotencyKey) {
    res.status(400).json({
      code: "ACCOUNTING_REQUEST_ID_REQUIRED",
      message: "This accounting operation requires a clientRequestId or X-Idempotency-Key.",
    });
    return;
  }
  if (idempotencyKey.length > REQUEST_KEY_MAX) {
    res.status(400).json({
      code: "ACCOUNTING_REQUEST_ID_INVALID",
      message: "Accounting request identity is too long.",
    });
    return;
  }

  await ensureOperationalVoucherRequestTable();
  const fingerprint = requestFingerprint(req);
  const claimed = await claimRequest(companyId, idempotencyKey, req.path, fingerprint);

  if (!claimed) {
    let stored = await loadStoredRequest(companyId, idempotencyKey);
    if (!stored) {
      res.status(409).json({
        code: "ACCOUNTING_REQUEST_STATE_UNAVAILABLE",
        message: "Request identity state is unavailable.",
      });
      return;
    }
    if (stored.requestPath !== req.path || stored.requestFingerprint !== fingerprint) {
      res.status(409).json({
        code: "POSTING_IDEMPOTENCY_CONFLICT",
        message:
          "This request identity was already used for a different accounting operation, payload, or authorization context.",
      });
      return;
    }
    if (stored.state !== "completed") {
      stored = await waitForCompletedRequest(companyId, idempotencyKey);
    }
    if (stored?.state === "completed") {
      sendStoredResponse(res, stored);
      return;
    }

    res.status(409).json({
      code: "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN",
      message:
        "The original accounting request is still processing or its outcome is uncertain. It was not executed again.",
    });
    return;
  }

  let responseBody: unknown = null;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as typeof res.json;
  res.send = ((body?: unknown) => {
    if (responseBody === null && body !== undefined) responseBody = body;
    return originalSend(body);
  }) as typeof res.send;

  res.once("finish", () => {
    void storeResponse(companyId, idempotencyKey, res.statusCode, responseBody).catch(() => {
      // Leave the request in processing/uncertain state. A retry must fail closed
      // rather than risk running a possibly committed accounting operation twice.
    });
  });

  next();
}

export function registerOperationalVoucherRequestBoundary(app: Express): void {
  app.use((req, res, next) => {
    if (!isPhase4OperationalVoucherRequest(req.method, req.path, req.body) || isOptionalVoucherRequest(req)) {
      next();
      return;
    }

    void requireAuth(req, res, (authError?: unknown) => {
      if (authError) {
        next(authError);
        return;
      }
      void operationalVoucherBoundary(req, res, next).catch(next);
    });
  });
}
