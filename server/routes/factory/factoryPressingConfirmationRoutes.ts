/**
 * Physical bale pressing confirmation — NOT Factory inventory finalization.
 * The authoritative company/user, machine assignment and bale are all resolved
 * inside the transaction. No stock, mix cost, voucher or bale state is mutated.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  factoryBales, factoryPressingMachines, factoryPressingAssignments,
  factoryPressingSessions, factoryPressingConfirmations, factorySettings,
  factoryPressingShifts, factoryPressingDowntime, factoryPressingCorrections,
  users,
} from "@shared/schema";
import {
  ActiveCompanyPermissionContextError, getActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logAudit } from "../helpers/auditHelpers";
import { logger } from "../../lib/logger";
import {
  factoryLocalDate, factoryTimezone, matchingShift, type PressingShiftDefinition,
} from "../../services/factory/pressingShiftTime";

const confirmSchema = z.object({
  barcode: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  assignmentId: z.number().int().positive(),
  machineId: z.number().int().positive(),
  requestId: z.string().uuid(),
  deviceCapturedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

type ConfirmInput = z.infer<typeof confirmSchema>;
class ConfirmationError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: string, message: string,
    public readonly details?: Record<string, unknown>) {
    super(message);
  }
}

function normalizeReference(value: string): string {
  return value.trim().toUpperCase();
}
function safeDeviceTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function isNonBalePriorityProduct(extra: unknown, productId: number | null): boolean {
  if (!productId || !extra || typeof extra !== "object" || Array.isArray(extra)) return false;
  const excluded = (extra as Record<string, unknown>).nonBalePriorityProductIds;
  return Array.isArray(excluded) && excluded.some(id => Number(id) === productId);
}
function sendFailure(res: Response, error: unknown): void {
  if (error instanceof ConfirmationError) {
    res.status(error.httpStatus).json({ code: error.code, message: error.message, ...error.details });
    return;
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ code: "INVALID_PRESSING_SCAN", message: "Invalid pressing barcode request", issues: error.issues });
    return;
  }
  logger.error("Factory pressing confirmation failed", { error });
  res.status(500).json({ code: "PRESSING_CONFIRMATION_FAILED", message: "Could not confirm pressing. Please retry with the same request ID." });
}

function receipt(row: typeof factoryPressingConfirmations.$inferSelect, replayed = false) {
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

export function registerFactoryPressingConfirmRoutes(app: Express): void {
  app.post("/api/factory/pressing-machines/confirm", requireAuth, async (req: Request, res: Response) => {
    let parsed: ConfirmInput;
    try {
      parsed = confirmSchema.parse(req.body);
      const ctx = await getActiveCompanyPermissionContext(req);
      if (ctx.posViewOnly || ["View Only", "ERP Tester"].includes(ctx.role)) {
        throw new ConfirmationError(403, "PRESSING_WRITE_DENIED", "Your role cannot confirm pressing");
      }
      const reference = normalizeReference(parsed.barcode);
      const companyId = ctx.companyId;
      const userId = ctx.userId;
      const existingRequest = await db.select().from(factoryPressingConfirmations)
        .where(and(eq(factoryPressingConfirmations.companyId, companyId),
          eq(factoryPressingConfirmations.requestId, parsed.requestId))).limit(1);
      if (existingRequest.length) {
        const prior = existingRequest[0];
        if (prior.referenceNumber !== reference || prior.userId !== userId ||
          prior.machineId !== parsed.machineId || prior.assignmentId !== parsed.assignmentId) {
          throw new ConfirmationError(409, "PRESSING_REQUEST_ID_REUSED", "Request ID was already used for another scan");
        }
        if (prior.voidedAt) throw new ConfirmationError(409, "PRESSING_CONFIRMATION_VOIDED", "That prior scan was voided; a new confirmation request is required");
        return res.json(receipt(prior, true));
      }

      const result = await db.transaction(async tx => {
        // Same lock ordering as the supervisor assignment endpoint: lock user
        // first, machine next, assignment last. Reassignments cannot race a
        // pressing confirmation into the wrong machine's production.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId}::integer, hashtext(${userId}))`);
        const [machine] = await tx.select().from(factoryPressingMachines)
          .where(and(eq(factoryPressingMachines.companyId, companyId),
            eq(factoryPressingMachines.id, parsed.machineId))).for("update");
        if (!machine?.active) {
          throw new ConfirmationError(422, "PRESSING_MACHINE_INACTIVE", "Machine is inactive or no longer assigned");
        }
        const [machineDowntime] = await tx.select({ id: factoryPressingDowntime.id })
          .from(factoryPressingDowntime).where(and(
            eq(factoryPressingDowntime.companyId, companyId),
            eq(factoryPressingDowntime.machineId, machine.id),
            isNull(factoryPressingDowntime.endedAt),
          )).limit(1);
        if (machineDowntime) {
          throw new ConfirmationError(422, "PRESSING_MACHINE_DOWN",
            "Supervisor has marked this machine down. Scan after downtime ends.");
        }
        const [assignment] = await tx.select().from(factoryPressingAssignments)
          .where(and(eq(factoryPressingAssignments.companyId, companyId),
            eq(factoryPressingAssignments.id, parsed.assignmentId),
            eq(factoryPressingAssignments.machineId, machine.id),
            eq(factoryPressingAssignments.userId, userId),
            isNull(factoryPressingAssignments.unassignedAt))).for("update");
        if (!assignment) {
          throw new ConfirmationError(409, "PRESSING_ASSIGNMENT_CHANGED", "Your assigned machine has changed. Refresh before scanning.");
        }
        const [operator] = await tx.select({ active: users.active, username: users.username })
          .from(users).where(eq(users.id, userId)).limit(1);
        if (!operator?.active) {
          throw new ConfirmationError(403, "PRESSING_USER_INACTIVE", "Your user account is inactive");
        }

        // Return an idempotent receipt even after a race with the initial
        // pretransaction lookup. It must be the SAME actor/barcode/assignment.
        const [prior] = await tx.select().from(factoryPressingConfirmations)
          .where(and(eq(factoryPressingConfirmations.companyId, companyId),
            eq(factoryPressingConfirmations.requestId, parsed.requestId))).limit(1);
        if (prior) {
          if (prior.referenceNumber !== reference || prior.userId !== userId ||
              prior.machineId !== machine.id || prior.assignmentId !== assignment.id) {
            throw new ConfirmationError(409, "PRESSING_REQUEST_ID_REUSED", "Request ID was already used for another scan");
          }
          if (prior.voidedAt) throw new ConfirmationError(409, "PRESSING_CONFIRMATION_VOIDED", "That prior scan was voided; a new confirmation request is required");
          return { row: prior, replayed: true };
        }

        const [bale] = await tx.select().from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId),
            eq(factoryBales.referenceNumber, reference),
            isNull(factoryBales.deletedAt))).for("update");
        if (!bale || bale.status === "DELETED") {
          throw new ConfirmationError(404, "PRESSING_BALE_NOT_FOUND", "This reference is not an active factory bale");
        }
        const [settings] = await tx.select({ extraSettings: factorySettings.extraSettings })
          .from(factorySettings).where(eq(factorySettings.companyId, companyId)).limit(1);
        if (isNonBalePriorityProduct(settings?.extraSettings, bale.productId)) {
          throw new ConfirmationError(422, "PRESSING_NON_BALE_ITEM", "Non-bale priority products cannot be recorded as pressed bales");
        }
        const [alreadyPressed] = await tx.select().from(factoryPressingConfirmations)
          .where(and(eq(factoryPressingConfirmations.companyId, companyId),
            eq(factoryPressingConfirmations.baleId, bale.id),
            isNull(factoryPressingConfirmations.voidedAt))).limit(1);
        if (alreadyPressed) {
          throw new ConfirmationError(409, "PRESSING_ALREADY_CONFIRMED",
            "Already confirmed on " + alreadyPressed.machineNameSnapshot + " at " + alreadyPressed.confirmedAt.toISOString(),
            { previous: {
              confirmedAt: alreadyPressed.confirmedAt.toISOString(),
              machineName: alreadyPressed.machineNameSnapshot,
              operatorUserId: alreadyPressed.userId,
              referenceNumber: alreadyPressed.referenceNumber,
            } });
        }

        // Stock finalization is intentionally independent: do not re-confirm
        // any bale already finalized, sold or dispatched, even if no earlier
        // machine scan was recorded.
        if (bale.status !== "PENDING_PRESSING") {
          throw new ConfirmationError(422, "PRESSING_BALE_NOT_PENDING", "Only pending-pressing bales can be confirmed");
        }

        // Assign the shift using the SERVER confirmation time, not an
        // untrusted phone clock. Overnight times and IANA zones are supported.
        const now = new Date();
        const activeShifts = await tx.select().from(factoryPressingShifts)
          .where(and(eq(factoryPressingShifts.companyId, companyId),
            eq(factoryPressingShifts.active, true)));
        const activeShift = matchingShift(activeShifts as PressingShiftDefinition[], now);
        const shiftId = activeShift?.id ?? null;
        // One calendar basis per company: the configured shifts' timezone even
        // when this scan falls outside every shift, else Factory settings.
        const timezoneName = factoryTimezone(activeShifts, settings?.extraSettings);
        const productionDate = factoryLocalDate(now, timezoneName);
        const deviceCapturedAt = safeDeviceTimestamp(parsed.deviceCapturedAt);
        let session: typeof factoryPressingSessions.$inferSelect | undefined;
        [session] = await tx.select().from(factoryPressingSessions)
          .where(and(eq(factoryPressingSessions.companyId, companyId),
            eq(factoryPressingSessions.userId, userId),
            isNull(factoryPressingSessions.endedAt))).for("update");
        if (session && (session.machineId !== machine.id || session.assignmentId !== assignment.id)) {
          throw new ConfirmationError(409, "PRESSING_SESSION_STALE", "Operator session is for another machine");
        }
        // A shift boundary ends the old session, preserving every previously
        // confirmed scan's original shift attribution, and opens a new one.
        if (session && session.shiftId !== shiftId) {
          await tx.update(factoryPressingSessions).set({ endedAt: now })
            .where(and(eq(factoryPressingSessions.id, session.id),
              eq(factoryPressingSessions.companyId, companyId)));
          session = undefined;
        }
        if (!session) {
          [session] = await tx.insert(factoryPressingSessions)
            .values({ companyId, userId, machineId: machine.id, assignmentId: assignment.id,
              shiftId, startedAt: now })
            .returning();
        }

        // The database's partial unique company+bale index is the final
        // concurrency boundary across every machine, operator and calendar day.
        // ON CONFLICT DO NOTHING avoids aborting the transaction so we can
        // classify the existing confirmation into a precise 409 response.
        const [created] = await tx.insert(factoryPressingConfirmations)
          .values({
            companyId, baleId: bale.id, machineId: machine.id,
            assignmentId: assignment.id, sessionId: session.id, shiftId,
            userId, userNameSnapshot: operator.username, machineNameSnapshot: machine.name,
            referenceNumber: bale.referenceNumber, articleCode: bale.articleCode,
            productName: bale.productName, weightKg: bale.weightKg,
            requestId: parsed.requestId, deviceCapturedAt, confirmedAt: now,
            productionDate, timezoneName,
          }).onConflictDoNothing().returning();
        if (!created) {
          const [byRequest] = await tx.select().from(factoryPressingConfirmations)
            .where(and(eq(factoryPressingConfirmations.companyId, companyId),
              eq(factoryPressingConfirmations.requestId, parsed.requestId))).limit(1);
          if (byRequest && byRequest.userId === userId && byRequest.referenceNumber === reference &&
              byRequest.machineId === machine.id && byRequest.assignmentId === assignment.id) {
            if (byRequest.voidedAt) throw new ConfirmationError(409, "PRESSING_CONFIRMATION_VOIDED", "That prior scan was voided; use a new request ID");
            return { row: byRequest, replayed: true };
          }
          const [other] = await tx.select().from(factoryPressingConfirmations)
            .where(and(eq(factoryPressingConfirmations.companyId, companyId),
              eq(factoryPressingConfirmations.baleId, bale.id),
              isNull(factoryPressingConfirmations.voidedAt))).limit(1);
          if (other) {
            throw new ConfirmationError(409, "PRESSING_ALREADY_CONFIRMED",
              "Already confirmed on " + other.machineNameSnapshot + " at " + other.confirmedAt.toISOString(), { previous: {
                confirmedAt: other.confirmedAt.toISOString(),
                machineName: other.machineNameSnapshot,
                operatorUserId: other.userId,
                referenceNumber: other.referenceNumber,
              } });
          }
          throw new ConfirmationError(409, "PRESSING_REQUEST_ID_REUSED", "Request ID was already used");
        }
        // If a supervisor voided a previous scan, link the replacement to the
        // previous immutable event. This link is append-only, committed in
        // the SAME transaction as this new confirmation. A normal first scan
        // creates no correction record.
        const [voidedPrior] = await tx.select().from(factoryPressingConfirmations)
          .where(and(eq(factoryPressingConfirmations.companyId, companyId),
            eq(factoryPressingConfirmations.baleId, bale.id),
            isNotNull(factoryPressingConfirmations.voidedAt)))
          .orderBy(desc(factoryPressingConfirmations.voidedAt),
            desc(factoryPressingConfirmations.id)).limit(1);
        if (voidedPrior?.voidedBy) {
          const [originalCorrection] = await tx.select({ id: factoryPressingCorrections.id })
            .from(factoryPressingCorrections).where(and(
              eq(factoryPressingCorrections.companyId, companyId),
              eq(factoryPressingCorrections.confirmationId, voidedPrior.id),
              eq(factoryPressingCorrections.action, "VOID"),
            )).orderBy(desc(factoryPressingCorrections.id)).limit(1);
          await tx.insert(factoryPressingCorrections).values({
            companyId, confirmationId: voidedPrior.id,
            replacementConfirmationId: created.id, action: "RECONFIRM",
            reason: "Replacement pressing scan after supervisor void #" + (originalCorrection?.id ?? voidedPrior.id),
            supervisorUserId: voidedPrior.voidedBy,
          });
        }
        await logAudit({
          userId, username: operator.username, companyId,
          action: "create", tableName: "factory_pressing_confirmations",
          recordId: created.id, recordIdentifier: created.referenceNumber,
          changes: {
            machineId: { old: null, new: created.machineId },
            assignmentId: { old: null, new: created.assignmentId },
            pressedAt: { old: null, new: created.confirmedAt.toISOString() },
          },
        }, tx);
        return { row: created, replayed: false };
      });
      return res.status(result.replayed ? 200 : 201).json(receipt(result.row, result.replayed));
    } catch (error) {
      sendFailure(res, error);
    }
  });
}
