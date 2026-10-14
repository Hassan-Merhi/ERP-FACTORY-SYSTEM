import type { Response } from "express";

export type SpLifecycleCode =
  | "SP_LIFECYCLE_REASON_REQUIRED"
  | "SP_LIFECYCLE_ALREADY_DONE"
  | "SP_SALE_NOT_REVERSIBLE"
  | "SP_CONTAINER_NOT_CANCELLABLE"
  | "SP_LIFECYCLE_CONFLICT";

export class SpLifecycleError extends Error {
  readonly code: SpLifecycleCode;
  readonly statusCode: 400 | 404 | 409;

  constructor(message: string, code: SpLifecycleCode, statusCode: 400 | 404 | 409) {
    super(message);
    this.name = "SpLifecycleError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function normalizeSpLifecycleReason(value: unknown, action: string): string {
  const reason = String(value ?? "").trim();
  if (reason.length < 5) {
    throw new SpLifecycleError(
      `A reason of at least 5 characters is required to ${action}.`,
      "SP_LIFECYCLE_REASON_REQUIRED",
      400
    );
  }
  if (reason.length > 500) {
    throw new SpLifecycleError(
      `The ${action} reason must be 500 characters or fewer.`,
      "SP_LIFECYCLE_REASON_REQUIRED",
      400
    );
  }
  return reason;
}

export function assertSpSaleReversible(status: unknown): void {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "reversed") {
    throw new SpLifecycleError("This Supplier Partner sale has already been reversed.", "SP_SALE_NOT_REVERSIBLE", 409);
  }
  if (normalized !== "posted") {
    throw new SpLifecycleError(
      `Only posted Supplier Partner sales can be reversed. Current status: ${normalized || "unknown"}.`,
      "SP_SALE_NOT_REVERSIBLE",
      409
    );
  }
}

export function assertSpContainerCancellable(params: {
  status: unknown;
  offloadCount: number;
  stockMovementCount: number;
  usedPrepaidAmount: number;
}): void {
  const normalized = String(params.status ?? "").toLowerCase();
  if (normalized === "cancelled") {
    throw new SpLifecycleError(
      "This Supplier Partner container has already been cancelled.",
      "SP_CONTAINER_NOT_CANCELLABLE",
      409
    );
  }
  if (normalized !== "open") {
    throw new SpLifecycleError(
      `Only open Supplier Partner containers can be cancelled. Current status: ${normalized || "unknown"}.`,
      "SP_CONTAINER_NOT_CANCELLABLE",
      409
    );
  }
  if (params.offloadCount > 0 || params.stockMovementCount > 0) {
    throw new SpLifecycleError(
      "This container already has offload or stock activity and cannot be cancelled. Use the reverse-offload workflow instead.",
      "SP_CONTAINER_NOT_CANCELLABLE",
      409
    );
  }
  if (params.usedPrepaidAmount > 0.0001) {
    throw new SpLifecycleError(
      "This container has prepaid charges that were already used and cannot be cancelled safely.",
      "SP_CONTAINER_NOT_CANCELLABLE",
      409
    );
  }
}

export function restoredSpLotQuantity(params: {
  qtyIn: unknown;
  qtyRemaining: unknown;
  qtyToRestore: unknown;
  context: string;
}): number {
  const qtyIn = Number(params.qtyIn);
  const qtyRemaining = Number(params.qtyRemaining);
  const qtyToRestore = Number(params.qtyToRestore);

  if (![qtyIn, qtyRemaining, qtyToRestore].every(Number.isFinite) || qtyToRestore <= 0) {
    throw new SpLifecycleError(
      `${params.context} contains invalid stock quantities and cannot be reversed.`,
      "SP_LIFECYCLE_CONFLICT",
      409
    );
  }

  const restored = qtyRemaining + qtyToRestore;
  if (restored > qtyIn + 0.0001) {
    throw new SpLifecycleError(
      `${params.context} would restore the lot above its original received quantity.`,
      "SP_LIFECYCLE_CONFLICT",
      409
    );
  }
  return restored;
}

export function appendSpLifecycleNote(params: {
  existingNotes: unknown;
  action: "SALE REVERSED" | "CONTAINER CANCELLED" | "OFFLOAD REVERSED";
  reason: string;
  username: unknown;
  date: string;
}): string {
  const actor = String(params.username ?? "unknown user").trim() || "unknown user";
  const entry = `[${params.action} ${params.date} by ${actor}] ${params.reason}`;
  const existing = String(params.existingNotes ?? "").trim();
  return existing ? `${existing}\n${entry}` : entry;
}

export function respondToSpLifecycleError(res: Response, error: unknown): boolean {
  if (!(error instanceof SpLifecycleError)) return false;
  res.status(error.statusCode).json({ code: error.code, message: error.message });
  return true;
}
