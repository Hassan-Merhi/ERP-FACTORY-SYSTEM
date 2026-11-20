import type { NextFunction, Request, Response } from "express";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { persistSecurityEvent } from "./securityAuditRuntime";
import {
  UnsafeInputError,
  validateUnsafeOperationInput,
  type UnsafeOperationSchema,
} from "./unsafeOperationValidation";

const provenanceFields = Object.freeze({
  reason: Object.freeze({ kind: "string" as const, minLength: 3, maxLength: 500 }),
  idempotencyKey: Object.freeze({ kind: "string" as const, minLength: 8, maxLength: 200 }),
  // The retry identity client/src/lib/accountingRequestFetchGuard.ts adds to
  // every /api/factory/raw-stock/* write (a Phase 5 operational voucher path).
  // The voucher-path boundary reads it; refusing it refused the app's own calls.
  clientRequestId: Object.freeze({ kind: "string" as const, minLength: 8, maxLength: 200 }),
});

function schema(
  fields: UnsafeOperationSchema["fields"],
  options: { maxArrayLength?: number; maxDepth?: number } = {}
): UnsafeOperationSchema {
  return Object.freeze({
    fields: Object.freeze({ ...fields, ...provenanceFields }),
    allowUnknownFields: false,
    maxDepth: options.maxDepth ?? 3,
    maxArrayLength: options.maxArrayLength ?? 500,
    maxStringLength: 2_000,
  });
}

const ROUTE_SCHEMAS: Readonly<Record<string, UnsafeOperationSchema>> = Object.freeze({
  "/api/factory/raw-stock/recalc/apply": schema({
    containerIds: Object.freeze({ kind: "array" as const, required: true }),
    confirm: Object.freeze({ kind: "boolean" as const }),
    confirmationToken: Object.freeze({ kind: "string" as const, minLength: 3, maxLength: 4_000 }),
    includeCompletedBatches: Object.freeze({ kind: "boolean" as const }),
    includeHistoricalContainers: Object.freeze({ kind: "boolean" as const }),
  }),
  "/api/factory/raw-stock/recalc/zero-cost-sources/apply": schema(
    {
      sourceIds: Object.freeze({ kind: "array" as const, required: true }),
      manualRates: Object.freeze({ kind: "object" as const }),
      confirm: Object.freeze({ kind: "boolean" as const }),
      confirmationToken: Object.freeze({ kind: "string" as const, minLength: 3, maxLength: 4_000 }),
    },
    { maxDepth: 4 }
  ),
  "/api/factory/raw-stock/recalc/apply-all-safe": schema({
    confirm: Object.freeze({ kind: "boolean" as const }),
    confirmationToken: Object.freeze({ kind: "string" as const, minLength: 3, maxLength: 4_000 }),
    includeHistoricalContainers: Object.freeze({ kind: "boolean" as const }),
    includeCompletedBatches: Object.freeze({ kind: "boolean" as const }),
  }),
  "/api/factory/raw-stock/recalc/auto-apply-fx": schema({
    containerIds: Object.freeze({ kind: "array" as const, required: true }),
  }),
  "/api/factory/raw-stock/supplier-rate/recompute": schema({
    supplierId: Object.freeze({ kind: "positive-integer" as const }),
  }),
  "/api/factory/raw-stock/recalc/fix-source-mismatches": schema({}),
  "/api/factory/raw-stock/recalc/undo": schema({
    undoLogId: Object.freeze({ kind: "positive-integer" as const, required: true }),
  }),
});

function canonicalRoutePath(req: Request): string {
  const originalPath = String(req.originalUrl || req.url || req.path).split("?", 1)[0];
  return originalPath.length > 1 ? originalPath.replace(/\/+$/, "") : originalPath;
}

function positiveIntegerArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: field }]);
  }
  if (value.some((item) => typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0)) {
    throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: field }]);
  }
  const unique = [...new Set(value as number[])];
  if (unique.length !== value.length) {
    throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: field }]);
  }
  return unique;
}

function validateManualRates(value: unknown, sourceIds: readonly number[]): void {
  if (value === undefined) return;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: "manualRates" }]);
  }
  const allowed = new Set(sourceIds.map(String));
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > sourceIds.length) {
    throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: "manualRates" }]);
  }
  for (const [key, rate] of entries) {
    if (!/^\d+$/.test(key) || !allowed.has(key)) {
      throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: `manualRates.${key}` }]);
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
      throw new UnsafeInputError([{ code: "INVALID_FIELD_VALUE", path: `manualRates.${key}` }]);
    }
  }
}

async function auditInputDecision(
  req: Request,
  routePath: string,
  outcome: "allowed" | "denied",
  reasonCode: string
): Promise<void> {
  await persistSecurityEvent(
    db,
    {
      kind: "input-validation",
      action: "raw-stock-sensitive-input.validate",
      outcome,
      companyId: req.session?.currentCompanyId ?? null,
      actorUserId: req.session?.userId ?? null,
      targetType: "route",
      targetId: routePath,
      reasonCode,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: { method: req.method },
    },
    req.session?.username || req.session?.userId || "anonymous"
  );
}

/**
 * Exact, fail-closed payload boundary for the high-impact raw-stock writes
 * protected in Program 5E. The validated frozen object replaces req.body.
 */
export async function requireRawStockSensitiveInput(req: Request, res: Response, next: NextFunction) {
  if (req.method.toUpperCase() !== "POST") return next();
  const routePath = canonicalRoutePath(req);
  const routeSchema = ROUTE_SCHEMAS[routePath];
  if (!routeSchema) return next();

  try {
    const validated = validateUnsafeOperationInput({
      payload: req.body,
      schema: routeSchema,
      operation: routePath,
    });

    if ("containerIds" in validated) positiveIntegerArray(validated.containerIds, "containerIds");
    if ("sourceIds" in validated) {
      const sourceIds = positiveIntegerArray(validated.sourceIds, "sourceIds");
      validateManualRates(validated.manualRates, sourceIds);
    }

    req.body = validated;
    await auditInputDecision(req, routePath, "allowed", "INPUT_VALIDATED");
    return next();
  } catch (error) {
    if (error instanceof UnsafeInputError) {
      try {
        await auditInputDecision(req, routePath, "denied", error.issues[0]?.code || error.code);
      } catch (auditError) {
        logger.error("Security audit persistence failed:", { error: auditError });
        return res.status(500).json({ message: "Security audit unavailable" });
      }
      return res.status(400).json({ message: "Invalid request" });
    }
    return next(error);
  }
}
