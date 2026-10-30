/**
 * Phase 8: supervisor-only correction of PHYSICAL pressing confirmations.
 * A void never deletes or rewrites the original evidence; the existing
 * confirmation trigger requires an append-only VOID correction event before
 * the same transaction can set voided_at and voided_by.
 *
 * This endpoint intentionally NEVER calls stock finalization or ERP accounting.
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  factoryBales, factoryPressingMachines, factoryPressingConfirmations,
  factoryPressingCorrections, factoryUserProfiles,
} from "@shared/schema";
import {
  ActiveCompanyPermissionContextError, getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logAudit } from "../helpers/auditHelpers";
import { logger } from "../../lib/logger";

const SUPERVISORS = new Set(["Admin", "Owner"]);
const correctionRequest = z.object({
  // Legacy clients may still send a reason, but none is required.
  reason: z.string().trim().max(1000).optional(),
}).strict();
const listParams = z.object({
  confirmationId: z.coerce.number().int().positive().optional(),
  reference: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
}).strict();

class CorrectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(res: Response, error: unknown) {
  if (error instanceof CorrectionError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  if (error instanceof ActiveCompanyPermissionContextError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  if (error instanceof ZodError)
    return res.status(400).json({ code: "PRESSING_INVALID_CORRECTION", message: "Invalid pressing correction request", issues: error.issues });
  logger.error("Factory pressing correction failed", { error });
  return res.status(500).json({ code: "PRESSING_CORRECTION_FAILED", message: "Correction was not saved. Check history before trying again." });
}
async function requireSupervisor(req: Request): Promise<ActiveCompanyPermissionContext> {
  const ctx = await getActiveCompanyPermissionContext(req);
  if (!SUPERVISORS.has(ctx.role) || ctx.posViewOnly) {
    throw new CorrectionError(403, "PRESSING_SUPERVISOR_REQUIRED", "Only supervisors can correct pressing confirmations");
  }
  return ctx;
}
function validId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new CorrectionError(400, "INVALID_CONFIRMATION_ID", "Invalid pressing confirmation identifier");
  return id;
}

export function registerFactoryPressingCorrectionRoutes(app: Express): void {
  app.post("/api/factory/pressing-machines/confirmations/:id/void",
    requireAuth, async (req: Request, res: Response) => {
      try {
        const ctx = await requireSupervisor(req);
        const confirmationId = validId(req.params.id);
        const { reason: suppliedReason } = correctionRequest.parse(req.body ?? {});
        const reason = suppliedReason || "Deleted from active pressing scans by supervisor";
        const outcome = await db.transaction(async tx => {
          // Read identity first; acquire locks in the same order as Phase 4:
          // machine → bale → existing confirmation. This also serializes
          // against pressing and machine-downtime operations.
          const [target] = await tx.select({
            id: factoryPressingConfirmations.id,
            machineId: factoryPressingConfirmations.machineId,
            baleId: factoryPressingConfirmations.baleId,
          }).from(factoryPressingConfirmations).where(and(
            eq(factoryPressingConfirmations.companyId, ctx.companyId),
            eq(factoryPressingConfirmations.id, confirmationId),
          )).limit(1);
          if (!target) throw new CorrectionError(404, "PRESSING_CONFIRMATION_NOT_FOUND", "Pressing confirmation not found");
          const [machine] = await tx.select({ id: factoryPressingMachines.id })
            .from(factoryPressingMachines).where(and(
              eq(factoryPressingMachines.companyId, ctx.companyId),
              eq(factoryPressingMachines.id, target.machineId),
            )).for("update");
          if (!machine) throw new CorrectionError(404, "PRESSING_MACHINE_NOT_FOUND", "Machine not found");
          const [bale] = await tx.select({ id: factoryBales.id })
            .from(factoryBales).where(and(
              eq(factoryBales.companyId, ctx.companyId),
              eq(factoryBales.id, target.baleId),
            )).for("update");
          if (!bale) throw new CorrectionError(404, "PRESSING_BALE_NOT_FOUND", "Source bale not found");
          const [original] = await tx.select().from(factoryPressingConfirmations)
            .where(and(eq(factoryPressingConfirmations.companyId, ctx.companyId),
              eq(factoryPressingConfirmations.id, confirmationId))).for("update");
          if (!original) throw new CorrectionError(404, "PRESSING_CONFIRMATION_NOT_FOUND", "Pressing confirmation not found");
          if (original.voidedAt) {
            throw new CorrectionError(409, "PRESSING_ALREADY_VOIDED",
              "This confirmation has already been voided. Its original history is preserved.");
          }
          const now = new Date();
          // Append immutable evidence FIRST. The database trigger rejects
          // any void update without this matching supervisor correction.
          const [correction] = await tx.insert(factoryPressingCorrections).values({
            companyId: ctx.companyId,
            confirmationId: original.id,
            replacementConfirmationId: null,
            action: "VOID",
            reason,
            supervisorUserId: ctx.userId,
            createdAt: now,
          }).returning();
          const [voided] = await tx.update(factoryPressingConfirmations).set({
            voidedAt: now,
            voidedBy: ctx.userId,
          }).where(and(
            eq(factoryPressingConfirmations.companyId, ctx.companyId),
            eq(factoryPressingConfirmations.id, original.id),
          )).returning();
          await logAudit({
            userId: ctx.userId, username: String(req.session.username || ctx.userId),
            companyId: ctx.companyId, action: "void",
            tableName: "factory_pressing_confirmations",
            recordId: original.id, recordIdentifier: original.referenceNumber,
            changes: {
              reason: { old: null, new: reason },
              voidedAt: { old: null, new: now.toISOString() },
              machineId: { old: original.machineId, new: original.machineId },
              correctionId: { old: null, new: correction.id },
            },
          }, tx);
          return {
            correctionId: correction.id,
            confirmationId: voided.id,
            referenceNumber: voided.referenceNumber,
            voidedAt: now.toISOString(),
            voidedBy: ctx.userId,
            needsRescan: true,
            stockFinalized: false,
            message: "Pressing scan removed from active counts. The original remains in audit history.",
          };
        });
        return res.status(200).json(outcome);
      } catch (error) { return fail(res, error); }
    }
  );


  // One-click Return: restore a voided pressing result without rescanning or
  // editing historical evidence. A linked replacement keeps the original
  // operator, machine, measured KG, production date and scan timestamp.
  app.post("/api/factory/pressing-machines/confirmations/:id/restore",
    requireAuth, async (req: Request, res: Response) => {
      try {
        const ctx = await requireSupervisor(req);
        const confirmationId = validId(req.params.id);
        const outcome = await db.transaction(async tx => {
          const [target] = await tx.select({
            machineId: factoryPressingConfirmations.machineId,
            baleId: factoryPressingConfirmations.baleId,
          }).from(factoryPressingConfirmations).where(and(
            eq(factoryPressingConfirmations.companyId, ctx.companyId),
            eq(factoryPressingConfirmations.id, confirmationId),
          )).limit(1);
          if (!target) throw new CorrectionError(404, "PRESSING_CONFIRMATION_NOT_FOUND", "Pressing confirmation not found");

          // Match void and scan lock order to prevent concurrent duplicate restores.
          const [machine] = await tx.select({ id: factoryPressingMachines.id })
            .from(factoryPressingMachines).where(and(
              eq(factoryPressingMachines.companyId, ctx.companyId),
              eq(factoryPressingMachines.id, target.machineId),
            )).for("update");
          if (!machine) throw new CorrectionError(404, "PRESSING_MACHINE_NOT_FOUND", "Machine not found");
          const [bale] = await tx.select({
            id: factoryBales.id, deletedAt: factoryBales.deletedAt, status: factoryBales.status,
          }).from(factoryBales).where(and(
            eq(factoryBales.companyId, ctx.companyId),
            eq(factoryBales.id, target.baleId),
          )).for("update");
          if (!bale || bale.deletedAt || bale.status === "DELETED") {
            throw new CorrectionError(409, "PRESSING_BALE_DELETED",
              "A deleted factory bale cannot be returned to pressing counts");
          }
          const [original] = await tx.select().from(factoryPressingConfirmations)
            .where(and(
              eq(factoryPressingConfirmations.companyId, ctx.companyId),
              eq(factoryPressingConfirmations.id, confirmationId),
            )).for("update");
          if (!original) throw new CorrectionError(404, "PRESSING_CONFIRMATION_NOT_FOUND", "Pressing confirmation not found");
          if (!original.voidedAt) {
            throw new CorrectionError(409, "PRESSING_NOT_VOIDED", "This pressing scan is already active");
          }
          const [active] = await tx.select({ id: factoryPressingConfirmations.id })
            .from(factoryPressingConfirmations).where(and(
              eq(factoryPressingConfirmations.companyId, ctx.companyId),
              eq(factoryPressingConfirmations.baleId, original.baleId),
              isNull(factoryPressingConfirmations.voidedAt),
            )).limit(1);
          if (active) {
            throw new CorrectionError(409, "PRESSING_ALREADY_CONFIRMED",
              "This bale already has an active pressing scan; refresh the list");
          }
          const [restored] = await tx.insert(factoryPressingConfirmations).values({
            companyId: original.companyId,
            baleId: original.baleId,
            machineId: original.machineId,
            assignmentId: original.assignmentId,
            sessionId: original.sessionId,
            shiftId: original.shiftId,
            userId: original.userId,
            userNameSnapshot: original.userNameSnapshot,
            machineNameSnapshot: original.machineNameSnapshot,
            referenceNumber: original.referenceNumber,
            articleCode: original.articleCode,
            productName: original.productName,
            weightKg: original.weightKg,
            requestId: "supervisor-restore-" + randomUUID(),
            deviceCapturedAt: original.deviceCapturedAt,
            confirmedAt: original.confirmedAt,
            productionDate: original.productionDate,
            timezoneName: original.timezoneName,
          }).onConflictDoNothing().returning();
          if (!restored) {
            throw new CorrectionError(409, "PRESSING_ALREADY_CONFIRMED",
              "Another pressing scan is already active for this bale");
          }
          const now = new Date();
          const [correction] = await tx.insert(factoryPressingCorrections).values({
            companyId: ctx.companyId,
            confirmationId: original.id,
            replacementConfirmationId: restored.id,
            action: "RECONFIRM",
            reason: "Returned to active pressing scans by supervisor",
            supervisorUserId: ctx.userId,
            createdAt: now,
          }).returning();
          await logAudit({
            userId: ctx.userId, username: String(req.session.username || ctx.userId),
            companyId: ctx.companyId, action: "restore",
            tableName: "factory_pressing_confirmations",
            recordId: restored.id, recordIdentifier: restored.referenceNumber,
            changes: {
              returnedFromId: { old: null, new: original.id },
              correctionId: { old: null, new: correction.id },
              originalScanAt: { old: null, new: original.confirmedAt.toISOString() },
            },
          }, tx);
          return {
            confirmationId: restored.id,
            returnedFromId: original.id,
            correctionId: correction.id,
            referenceNumber: restored.referenceNumber,
            message: "Bale returned to active pressing scans",
          };
        });
        return res.status(200).json(outcome);
      } catch (error) { return fail(res, error); }
    }
  );

  app.get("/api/factory/pressing-machines/corrections",
    requireAuth, async (req: Request, res: Response) => {
      try {
        const ctx = await requireSupervisor(req);
        const filters = listParams.parse(req.query);
        const where = [eq(factoryPressingCorrections.companyId, ctx.companyId)];
        if (filters.confirmationId) {
          where.push(eq(factoryPressingCorrections.confirmationId, filters.confirmationId));
        }
        // Reference lookups use a company-scoped subquery, not unrestricted IDs.
        if (filters.reference) {
          const ids = await db.select({ id: factoryPressingConfirmations.id })
            .from(factoryPressingConfirmations).where(and(
              eq(factoryPressingConfirmations.companyId, ctx.companyId),
              eq(factoryPressingConfirmations.referenceNumber, filters.reference.toUpperCase()),
            )).limit(200);
          if (!ids.length) return res.json([]);
          // Avoid stitching user values into SQL. Company and reference are
          // parameterized; each original correction ID is server-selected.
          const values = ids.map(row => row.id);
          where.push(inArray(factoryPressingCorrections.confirmationId, values));
        }
        const rows = await db.select().from(factoryPressingCorrections)
          .where(and(...where)).orderBy(desc(factoryPressingCorrections.createdAt),
            desc(factoryPressingCorrections.id)).limit(filters.limit);
        // Supervisor identity stays as immutable user ID in the audit table,
        // but UI receives only the current company-specific display name.
        const supervisorIds = [...new Set(rows.map(row => row.supervisorUserId))];
        const profiles = supervisorIds.length
          ? await db.select({
              userId: factoryUserProfiles.userId,
              displayName: factoryUserProfiles.displayName,
            }).from(factoryUserProfiles).where(and(
              eq(factoryUserProfiles.companyId, ctx.companyId),
              inArray(factoryUserProfiles.userId, supervisorIds),
            ))
          : [];
        const names = new Map(profiles.map(row => [row.userId, row.displayName.trim()]));
        return res.json(rows.map(row => ({
          ...row,
          supervisorDisplayName: names.get(row.supervisorUserId) || "Display name not set",
        })));
      } catch (error) { return fail(res, error); }
    }
  );
}
