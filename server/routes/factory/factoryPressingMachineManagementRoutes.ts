/**
 * Simple pressing access, identical in setup to Ground Scan:
 * the owner grants Factory → Stock Entry → Pressing Machines permission.
 * Each allowed operator is automatically tracked by authenticated user ID.
 * Machines and assignment IDs are internal referential keys only.
 *
 * Old supervisor machine/assignment/target management APIs are intentionally
 * retired; existing rows and audit history are retained.
 */
import type { Express, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  factoryPressingMachines, factoryPressingAssignments, factoryPressingSessions, users,
} from "@shared/schema";
import {
  ActiveCompanyPermissionContextError, getActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logAudit } from "../helpers/auditHelpers";
import { logger } from "../../lib/logger";

class AccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function sendError(res: Response, error: unknown) {
  if (error instanceof AccessError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  if (error instanceof ActiveCompanyPermissionContextError)
    return res.status(error.status).json({ code: error.code, message: error.message });
  logger.error("Pressing access initialization failed", { error });
  return res.status(500).json({ code: "PRESSING_ACCESS_FAILED",
    message: "Unable to initialize pressing access. Retry without losing existing scans." });
}
async function currentAssignment(companyId: number, userId: string, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const [record] = await tx.select({
    assignmentId: factoryPressingAssignments.id,
    machineId: factoryPressingMachines.id,
    machineCode: factoryPressingMachines.machineCode,
    machineName: factoryPressingMachines.name,
    machineActive: factoryPressingMachines.active,
    assignedAt: factoryPressingAssignments.assignedAt,
  }).from(factoryPressingAssignments).innerJoin(factoryPressingMachines, and(
    eq(factoryPressingMachines.companyId, factoryPressingAssignments.companyId),
    eq(factoryPressingMachines.id, factoryPressingAssignments.machineId),
  )).where(and(
    eq(factoryPressingAssignments.companyId, companyId),
    eq(factoryPressingAssignments.userId, userId),
    isNull(factoryPressingAssignments.unassignedAt),
  )).limit(1);
  return record ?? null;
}
export function registerFactoryPressingMachineManagementRoutes(app: Express) {
  app.get("/api/factory/pressing-machines/me", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      return res.json({
        companyId: ctx.companyId, userId: ctx.userId,
        // Company-wide dashboard and scanner for Admin, Owner and Developer.
        canManage: ["Admin", "Owner", "Developer"].includes(ctx.role) && !ctx.posViewOnly,
        assignment: await db.transaction(async tx => currentAssignment(ctx.companyId, ctx.userId, tx)),
      });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/factory/pressing-machines/activate", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      if (ctx.posViewOnly || ["View Only", "ERP Tester"].includes(ctx.role))
        throw new AccessError(403, "PRESSING_WRITE_DENIED", "Your account is not permitted to scan");
      const data = await db.transaction(async tx => {
        // Serialized with pressing confirmations so a user cannot be assigned
        // to different internal stations in an in-flight scan.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ctx.companyId}::integer, hashtext(${ctx.userId}))`);
        const [user] = await tx.select({ active: users.active }).from(users)
          .where(eq(users.id, ctx.userId)).limit(1);
        if (!user?.active)
          throw new AccessError(403, "PRESSING_USER_INACTIVE", "Inactive users cannot scan bales");

        const existing = await currentAssignment(ctx.companyId, ctx.userId, tx);
        if (existing?.machineActive) return existing;
        if (existing) {
          const now = new Date();
          await tx.update(factoryPressingSessions).set({ endedAt: now }).where(and(
            eq(factoryPressingSessions.companyId, ctx.companyId),
            eq(factoryPressingSessions.userId, ctx.userId),
            isNull(factoryPressingSessions.endedAt),
          ));
          await tx.update(factoryPressingAssignments).set({
            unassignedAt: now, unassignedBy: ctx.userId,
          }).where(and(eq(factoryPressingAssignments.companyId, ctx.companyId),
            eq(factoryPressingAssignments.id, existing.assignmentId)));
        }

        await tx.insert(factoryPressingMachines).values({
          companyId: ctx.companyId, machineCode: "PRESSING-SCAN",
          name: "Pressing Scan", active: true, createdBy: ctx.userId,
        }).onConflictDoNothing();
        const [station] = await tx.select().from(factoryPressingMachines).where(and(
          eq(factoryPressingMachines.companyId, ctx.companyId),
          eq(factoryPressingMachines.machineCode, "PRESSING-SCAN"),
        )).for("update").limit(1);
        if (!station) throw new AccessError(500, "PRESSING_STATION_MISSING", "Cannot prepare pressing scanner");
        if (!station.active) {
          await tx.update(factoryPressingMachines).set({ active: true, updatedAt: new Date() })
            .where(and(eq(factoryPressingMachines.companyId, ctx.companyId),
              eq(factoryPressingMachines.id, station.id)));
        }

        const [assignment] = await tx.insert(factoryPressingAssignments).values({
          companyId: ctx.companyId, machineId: station.id,
          userId: ctx.userId, assignedBy: ctx.userId,
        }).onConflictDoNothing().returning();
        if (assignment) {
          await logAudit({
            userId: ctx.userId, username: String(req.session.username || ctx.userId),
            companyId: ctx.companyId, action: "create",
            tableName: "factory_pressing_assignments",
            recordId: assignment.id, recordIdentifier: "PRESSING-SCAN",
          }, tx);
        }
        const result = await currentAssignment(ctx.companyId, ctx.userId, tx);
        if (!result) throw new AccessError(409, "PRESSING_ACCESS_RETRY", "Please retry pressing access");
        return { ...result, machineActive: true };
      });
      return res.json({ companyId: ctx.companyId, userId: ctx.userId, assignment: data });
    } catch (error) { return sendError(res, error); }
  });
}
