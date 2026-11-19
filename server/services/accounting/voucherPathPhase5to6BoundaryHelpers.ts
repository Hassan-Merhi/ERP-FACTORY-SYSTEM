// Extracted from ./voucherPathPhase5to6Boundary.ts
import { createHash } from "node:crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { isVoucherRequestPayload, type VoucherRequestPayload } from "@shared/voucherPathIdentityPolicy";

type GuardRow = {
  id: number | string;
  request_fingerprint: string;
  state: "processing" | "completed";
  response_status: number | null;
  response_body: unknown;
};

export type VoucherPathClaimResult =
  { kind: "owner" } | { kind: "replay"; status: number; body: unknown } | { kind: "conflict" } | { kind: "uncertain" };

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

export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function normalizedPath(req: Request): string {
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

export function phase5RequestIdentity(req: Request, body: VoucherRequestPayload): string | null {
  const header = req.get("X-Idempotency-Key")?.trim();
  if (header) return header;
  const fromBody = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : "";
  return fromBody || null;
}

export async function readGuard(companyId: number, idempotencyKey: string): Promise<GuardRow | null> {
  const result = await db.execute(sql`
    SELECT id, request_fingerprint, state, response_status, response_body
    FROM voucher_path_request_guards
    WHERE company_id = ${companyId} AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  return (result.rows[0] as GuardRow | undefined) ?? null;
}

export async function waitForCompletion(
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
