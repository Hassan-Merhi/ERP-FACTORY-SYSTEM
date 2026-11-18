// Extracted from ./factoryPressingConfirmationRoutes.ts to keep that module under the source-size cap.
import type { Response } from "express";
import { z, ZodError } from "zod";
import { factoryPressingConfirmations } from "@shared/schema";
import { ActiveCompanyPermissionContextError } from "../../services/security/activeCompanyPermissionContext";
import { logger } from "../../lib/logger";

export const confirmSchema = z
  .object({
    barcode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    assignmentId: z.number().int().positive(),
    machineId: z.number().int().positive(),
    requestId: z.string().uuid(),
    deviceCapturedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ConfirmInput = z.infer<typeof confirmSchema>;

export class ConfirmationError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function normalizeReference(value: string): string {
  return value.trim().toUpperCase();
}

export function safeDeviceTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function sendFailure(res: Response, error: unknown): void {
  if (error instanceof ConfirmationError) {
    res.status(error.httpStatus).json({ code: error.code, message: error.message, ...error.details });
    return;
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res
      .status(400)
      .json({ code: "INVALID_PRESSING_SCAN", message: "Invalid pressing barcode request", issues: error.issues });
    return;
  }
  logger.error("Factory pressing confirmation failed", { error });
  res.status(500).json({
    code: "PRESSING_CONFIRMATION_FAILED",
    message: "Could not confirm pressing. Please retry with the same request ID.",
  });
}

export function receipt(row: typeof factoryPressingConfirmations.$inferSelect, replayed = false) {
  return {
    id: row.id,
    status: "PRESSING_COMPLETED" as const,
    referenceNumber: row.referenceNumber,
    articleCode: row.articleCode,
    productName: row.productName,
    weightKg: row.weightKg,
    baleId: row.baleId,
    machineId: row.machineId,
    machineName: row.machineNameSnapshot,
    operatorUserId: row.userId,
    assignmentId: row.assignmentId,
    sessionId: row.sessionId,
    shiftId: row.shiftId,
    confirmedAt: row.confirmedAt.toISOString(),
    deviceCapturedAt: row.deviceCapturedAt?.toISOString() ?? null,
    productionDate: row.productionDate,
    timezoneName: row.timezoneName,
    requestId: row.requestId,
    replayed,
    inventoryFinalized: false,
  };
}
