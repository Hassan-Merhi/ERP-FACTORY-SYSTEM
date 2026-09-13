import type { Request } from "express";
import { DurableFinancialOperationError } from "./durableFinancialOperation";

export function financialOperationRequestPayload(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { clientRequestId: _clientRequestId, ...payload } = body as Record<string, unknown>;
  return payload;
}

export function resolveFinancialOperationKey(req: Request): string {
  const header = req.get("X-Idempotency-Key")?.trim() || "";
  const bodyValue =
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body.clientRequestId : undefined;
  const body = typeof bodyValue === "string" ? bodyValue.trim() : "";

  if (header && body && header !== body) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_IDEMPOTENCY_CONFLICT",
      "X-Idempotency-Key and clientRequestId must match when both are supplied"
    );
  }
  const key = header || body;
  if (!key) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_ID_REQUIRED",
      "This financial operation requires X-Idempotency-Key or clientRequestId"
    );
  }
  return key;
}

/**
 * Optional variant of `resolveFinancialOperationKey` for writers whose existing
 * callers do not send an identity yet.
 *
 * Returning null keeps the request servable exactly as before, while the two
 * transports still have to agree when a caller does supply both. A route that
 * combines this with a transaction-owned state guard gets replay safety from the
 * guard and a durable, transport-level replay from the identity when present.
 */
export function resolveOptionalFinancialOperationKey(req: Request): string | null {
  try {
    return resolveFinancialOperationKey(req);
  } catch (error) {
    if (error instanceof DurableFinancialOperationError && error.code === "FINANCIAL_OPERATION_ID_REQUIRED") {
      return null;
    }
    throw error;
  }
}

export function financialOperationErrorStatus(error: unknown): number {
  if (!(error instanceof DurableFinancialOperationError)) return 500;
  if (
    error.code === "FINANCIAL_OPERATION_ID_REQUIRED" ||
    error.code === "FINANCIAL_OPERATION_ID_INVALID" ||
    error.code === "FINANCIAL_OPERATION_COMPANY_INVALID"
  ) {
    return 400;
  }
  if (
    error.code === "FINANCIAL_OPERATION_IDEMPOTENCY_CONFLICT" ||
    error.code === "FINANCIAL_OPERATION_OUTCOME_UNCERTAIN" ||
    error.code === "FINANCIAL_OPERATION_STATE_UNAVAILABLE"
  ) {
    return 409;
  }
  return 500;
}
