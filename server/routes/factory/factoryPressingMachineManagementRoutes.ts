/**
 * Pressing Machines Phase 2: supervised catalog and effective-dated assignments.
 * No bale status, material, inventory, or voucher writes.
 */
import type { Express, Request, Response } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import {
  factoryPressingMachines, factoryPressingAssignments, factoryPressingSessions,
  factoryUserProfiles, factoryUserPageAccess, users, userCompanyRoles,
} from "@shared/schema";
import {
  ActiveCompanyPermissionContextError, getActiveCompanyPermissionContext,
  type ActiveCompanyPermissionContext,
} from "../../services/security/activeCompanyPermissionContext";
import { logAudit } from "../helpers/auditHelpers";
import { logger } from "../../lib/logger";
import { normalizePersistedFactoryPageKeysFailClosed } from "@shared/factoryPermissionCatalog";

const MANAGERS = new Set(["Developer", "Admin", "Owner", "Manager"]);
const NON_OPERATORS = new Set(["View Only", "ERP Tester"]);
const PRESSING_TAB_HIDDEN = "hide_tab_stockentry_pressing_machines";
const PRESSING_PAGE = "factory/stock-entry";
const machineCreate = z.object({
  machineCode: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  name: z.string().trim().min(1).max(160),
  targetBalesPerHour: z.number().finite().positive().max(100000).nullable().optional(),
}).strict();
const machineUpdate = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
  targetBalesPerHour: z.number().finite().positive().max(100000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, "No changes supplied");
const assignSchema = z.object({
  machineId: z.number().int().positive(),
  userId: z.string().min(1).max(255),
}).strict();
const numericId = (raw: string) => {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

type Context = ActiveCompanyPermissionContext;
function canManage(ctx: Context): boolean {
  return MANAGERS.has(ctx.role) && !ctx.posViewOnly;
}
class PressingManagementError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function respondError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ message: "Invalid machine or assignment data", issues: error.issues });
    return;
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof PressingManagementError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  const pgError = error as { code?: string; cause?: { code?: string } };
  if (pgError?.code === "23505" || pgError?.cause?.code === "23505") {
    res.status(409).json({ code: "PRESSING_CONFLICT", message: "Machine code or assignment conflicts with an existing record" });
    return;
  }
  logger.error("Pressing machine management failed", { error });
  res.status(500).json({ message: "Could not complete pressing machine request" });
}
async function authorize(req: Request, manage: boolean): Promise<Context> {
  const ctx = await getActiveCompanyPermissionContext(req);
  if (manage && !canManage(ctx)) {
    throw new PressingManagementError(403, "PRESSING_SUPERVISOR_REQUIRED", "Supervisor role required");
  }
  return ctx;
}
function auditActor(req: Request, ctx: Context) {
  return { userId: ctx.userId, username: String(req.session.username || ctx.userId), companyId: ctx.companyId };
}
async function eligibleOperators(companyId: number) {
  const candidates = await db.select({
    id: users.id, username: users.username, role: userCompanyRoles.role,
    posViewOnly: userCompanyRoles.posViewOnly, factoryAccess: factoryUserProfiles.hasFactoryAccess,
    hiddenFields: factoryUserProfiles.hiddenCostFields,
  }).from(users)
    .innerJoin(userCompanyRoles, and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, companyId)))
    .leftJoin(factoryUserProfiles, and(eq(factoryUserProfiles.userId, users.id), eq(factoryUserProfiles.companyId, companyId)))
    .where(eq(users.active, true)).orderBy(asc(users.username));
  const grants = await db.select({ userId: factoryUserPageAccess.userId, pageKey: factoryUserPageAccess.pageKey })
    .from(factoryUserPageAccess).where(eq(factoryUserPageAccess.companyId, companyId));
  const byUser = new Map<string, string[]>();
  for (const row of grants) byUser.set(row.userId, [...(byUser.get(row.userId) || []), row.pageKey]);
  return candidates.filter(u => {
    if (NON_OPERATORS.has(u.role) || u.posViewOnly || u.factoryAccess === false) return false;
    if (["Admin", "Owner", "Developer"].includes(u.role)) return true;
    if ((u.hiddenFields || []).includes(PRESSING_TAB_HIDDEN)) return false;
    const pages = normalizePersistedFactoryPageKeysFailClosed(byUser.get(u.id) || []);
    return pages.length === 0 || pages.includes(PRESSING_PAGE);
  }).map(({ id, username, role }) => ({ id, username, role }));
}
async function dashboard(companyId: number) {
  const [machines, assignments, operators] = await Promise.all([
    db.select().from(factoryPressingMachines).where(eq(factoryPressingMachines.companyId, companyId))
      .orderBy(asc(factoryPressingMachines.machineCode)),
    db.select({
      id: factoryPressingAssignments.id, machineId: factoryPressingAssignments.machineId,
      userId: factoryPressingAssignments.userId, assignedBy: factoryPressingAssignments.assignedBy,
      assignedAt: factoryPressingAssignments.assignedAt, username: users.username,
    }).from(factoryPressingAssignments)
      .leftJoin(users, eq(users.id, factoryPressingAssignments.userId))
      .where(and(eq(factoryPressingAssignments.companyId, companyId), isNull(factoryPressingAssignments.unassignedAt)))
      .orderBy(desc(factoryPressingAssignments.assignedAt)),
    eligibleOperators(companyId),
  ]);
  return { machines, assignments, operators };
}
export function registerFactoryPressingMachineManagementRoutes(app: Express): void {
  // Only the current worker's machine is exposed here; never company-wide assignments.
  app.get("/api/factory/pressing-machines/me", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, false);
      const [assigned] = await db.select({
        assignmentId: factoryPressingAssignments.id,
        assignedAt: factoryPressingAssignments.assignedAt,
        machineId: factoryPressingMachines.id,
        machineCode: factoryPressingMachines.machineCode,
        machineName: factoryPressingMachines.name,
        machineActive: factoryPressingMachines.active,
      }).from(factoryPressingAssignments)
        .innerJoin(factoryPressingMachines, and(
          eq(factoryPressingMachines.companyId, factoryPressingAssignments.companyId),
          eq(factoryPressingMachines.id, factoryPressingAssignments.machineId),
        ))
        .where(and(
          eq(factoryPressingAssignments.companyId, ctx.companyId),
          eq(factoryPressingAssignments.userId, ctx.userId),
          isNull(factoryPressingAssignments.unassignedAt),
        )).limit(1);
      res.json({ companyId: ctx.companyId, userId: ctx.userId, assignment: assigned ?? null, canManage: canManage(ctx) });
    } catch (error) { respondError(res, error); }
  });

  app.get("/api/factory/pressing-machines", requireAuth, async (req: Request, res: Response) => {
    try { const ctx = await authorize(req, true); res.json(await dashboard(ctx.companyId)); }
    catch (error) { respondError(res, error); }
  });

  app.get("/api/factory/pressing-machines/history", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, true);
      const machineId = req.query.machineId === undefined ? null : numericId(String(req.query.machineId));
      const userId = req.query.userId === undefined ? null : String(req.query.userId);
      if (req.query.machineId !== undefined && !machineId) {
        throw new PressingManagementError(400, "INVALID_MACHINE", "Invalid machine ID");
      }
      if (userId !== null && (userId.length < 1 || userId.length > 255)) {
        throw new PressingManagementError(400, "INVALID_USER", "Invalid user ID");
      }
      const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || "100"), 10) || 100));
      const filters = [eq(factoryPressingAssignments.companyId, ctx.companyId)];
      if (machineId !== null) filters.push(eq(factoryPressingAssignments.machineId, machineId));
      if (userId !== null) filters.push(eq(factoryPressingAssignments.userId, userId));
      const records = await db.select({
        id: factoryPressingAssignments.id, machineId: factoryPressingAssignments.machineId,
        machineCode: factoryPressingMachines.machineCode, machineName: factoryPressingMachines.name,
        userId: factoryPressingAssignments.userId, username: users.username,
        assignedBy: factoryPressingAssignments.assignedBy, assignedAt: factoryPressingAssignments.assignedAt,
        unassignedBy: factoryPressingAssignments.unassignedBy, unassignedAt: factoryPressingAssignments.unassignedAt,
      }).from(factoryPressingAssignments)
        .innerJoin(factoryPressingMachines, and(
          eq(factoryPressingMachines.id, factoryPressingAssignments.machineId),
          eq(factoryPressingMachines.companyId, factoryPressingAssignments.companyId),
        ))
        .leftJoin(users, eq(users.id, factoryPressingAssignments.userId))
        .where(and(...filters))
        .orderBy(desc(factoryPressingAssignments.assignedAt), desc(factoryPressingAssignments.id))
        .limit(limit);
      res.json(records);
    } catch (error) { respondError(res, error); }
  });

  app.post("/api/factory/pressing-machines", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, true);
      const body = machineCreate.parse(req.body);
      const created = await db.transaction(async tx => {
        const [machine] = await tx.insert(factoryPressingMachines).values({
          companyId: ctx.companyId, machineCode: body.machineCode.toUpperCase(), name: body.name,
          targetBalesPerHour: body.targetBalesPerHour == null ? null : String(body.targetBalesPerHour),
          createdBy: ctx.userId,
        }).returning();
        await logAudit({ ...auditActor(req, ctx), action: "create",
          tableName: "factory_pressing_machines", recordId: machine.id, recordIdentifier: machine.machineCode }, tx);
        return machine;
      });
      res.status(201).json(created);
    } catch (error) { respondError(res, error); }
  });

  // POST deliberately bypasses the unrelated legacy global PATCH rule; this
  // endpoint has its own canonical active-company supervisor authorization.
  app.post("/api/factory/pressing-machines/:id/update", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, true);
      const id = numericId(req.params.id);
      if (!id) throw new PressingManagementError(400, "INVALID_MACHINE", "Invalid machine ID");
      const body = machineUpdate.parse(req.body);
      const machine = await db.transaction(async tx => {
        const [current] = await tx.select().from(factoryPressingMachines)
          .where(and(eq(factoryPressingMachines.id, id), eq(factoryPressingMachines.companyId, ctx.companyId))).for("update");
        if (!current) throw new PressingManagementError(404, "MACHINE_NOT_FOUND", "Machine not found");
        const now = new Date();
        const [updated] = await tx.update(factoryPressingMachines).set({
          name: body.name ?? current.name, active: body.active ?? current.active,
          targetBalesPerHour: body.targetBalesPerHour === undefined ? current.targetBalesPerHour :
            body.targetBalesPerHour == null ? null : String(body.targetBalesPerHour),
          updatedAt: now,
        }).where(and(eq(factoryPressingMachines.id, id), eq(factoryPressingMachines.companyId, ctx.companyId))).returning();
        if (current.active && updated.active === false) {
          await tx.update(factoryPressingSessions).set({ endedAt: now }).where(and(
            eq(factoryPressingSessions.companyId, ctx.companyId), eq(factoryPressingSessions.machineId, id),
            isNull(factoryPressingSessions.endedAt)));
          await tx.update(factoryPressingAssignments)
            .set({ unassignedAt: now, unassignedBy: ctx.userId })
            .where(and(eq(factoryPressingAssignments.companyId, ctx.companyId),
              eq(factoryPressingAssignments.machineId, id), isNull(factoryPressingAssignments.unassignedAt)));
        }
        await logAudit({ ...auditActor(req, ctx), action: "update", tableName: "factory_pressing_machines",
          recordId: id, recordIdentifier: current.machineCode,
          changes: { name: { old: current.name, new: updated.name },
            active: { old: current.active, new: updated.active },
            targetBalesPerHour: { old: current.targetBalesPerHour, new: updated.targetBalesPerHour } } }, tx);
        return updated;
      });
      res.json(machine);
    } catch (error) { respondError(res, error); }
  });

  app.post("/api/factory/pressing-machines/assignments", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, true);
      const body = assignSchema.parse(req.body);
      const outcome = await db.transaction(async tx => {
        // Serializes competing reassignments of the same user. The database
        // partial UNIQUE index remains the final defense against races.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ctx.companyId}::integer, hashtext(${body.userId}))`);
        const [machine] = await tx.select().from(factoryPressingMachines)
          .where(and(eq(factoryPressingMachines.id, body.machineId),
            eq(factoryPressingMachines.companyId, ctx.companyId))).for("update");
        if (!machine || !machine.active)
          throw new PressingManagementError(422, "MACHINE_INACTIVE", "Select an active machine");
        const [operator] = await tx.select({
          id: users.id, active: users.active, role: userCompanyRoles.role,
          posViewOnly: userCompanyRoles.posViewOnly, hasFactoryAccess: factoryUserProfiles.hasFactoryAccess,
          hiddenFields: factoryUserProfiles.hiddenCostFields,
        }).from(users)
          .innerJoin(userCompanyRoles, and(eq(userCompanyRoles.userId, users.id),
            eq(userCompanyRoles.companyId, ctx.companyId)))
          .leftJoin(factoryUserProfiles, and(eq(factoryUserProfiles.userId, users.id),
            eq(factoryUserProfiles.companyId, ctx.companyId)))
          .where(eq(users.id, body.userId)).limit(1);
        if (!operator || !operator.active || operator.posViewOnly ||
            NON_OPERATORS.has(operator.role) || operator.hasFactoryAccess === false)
          throw new PressingManagementError(422, "OPERATOR_NOT_ELIGIBLE", "Operator must be an active Factory user with edit access");
        if (!["Admin", "Owner", "Developer"].includes(operator.role)) {
          if ((operator.hiddenFields || []).includes(PRESSING_TAB_HIDDEN))
            throw new PressingManagementError(422, "OPERATOR_TAB_HIDDEN", "Operator cannot access Pressing Machines tab");
          const rows = await tx.select({ pageKey: factoryUserPageAccess.pageKey }).from(factoryUserPageAccess)
            .where(and(eq(factoryUserPageAccess.companyId, ctx.companyId), eq(factoryUserPageAccess.userId, body.userId)));
          const pages = normalizePersistedFactoryPageKeysFailClosed(rows.map(r => r.pageKey));
          if (pages.length && !pages.includes(PRESSING_PAGE))
            throw new PressingManagementError(422, "OPERATOR_PAGE_HIDDEN", "Operator cannot access Stock Entry");
        }
        const [existing] = await tx.select().from(factoryPressingAssignments)
          .where(and(eq(factoryPressingAssignments.companyId, ctx.companyId),
            eq(factoryPressingAssignments.userId, body.userId),
            isNull(factoryPressingAssignments.unassignedAt))).for("update");
        if (existing?.machineId === body.machineId) return { assignment: existing, unchanged: true };
        const now = new Date();
        if (existing) {
          await tx.update(factoryPressingSessions).set({ endedAt: now }).where(and(
            eq(factoryPressingSessions.companyId, ctx.companyId), eq(factoryPressingSessions.assignmentId, existing.id),
            isNull(factoryPressingSessions.endedAt)));
          await tx.update(factoryPressingAssignments).set({ unassignedAt: now, unassignedBy: ctx.userId })
            .where(eq(factoryPressingAssignments.id, existing.id));
        }
        const [assignment] = await tx.insert(factoryPressingAssignments).values({
          companyId: ctx.companyId, machineId: body.machineId, userId: body.userId,
          assignedBy: ctx.userId, assignedAt: now,
        }).returning();
        await logAudit({ ...auditActor(req, ctx), action: "permission_change",
          tableName: "factory_pressing_assignments", recordId: assignment.id, recordIdentifier: body.userId,
          changes: { machineId: { old: existing?.machineId ?? null, new: body.machineId } } }, tx);
        return { assignment, unchanged: false };
      });
      res.status(outcome.unchanged ? 200 : 201).json(outcome);
    } catch (error) { respondError(res, error); }
  });

  app.post("/api/factory/pressing-machines/assignments/:id/end", requireAuth, async (req: Request, res: Response) => {
    try {
      const ctx = await authorize(req, true);
      const id = numericId(req.params.id);
      if (!id) throw new PressingManagementError(400, "INVALID_ASSIGNMENT", "Invalid assignment ID");
      const result = await db.transaction(async tx => {
        const [candidate] = await tx.select({ userId: factoryPressingAssignments.userId })
          .from(factoryPressingAssignments)
          .where(and(eq(factoryPressingAssignments.id, id), eq(factoryPressingAssignments.companyId, ctx.companyId)));
        if (!candidate) throw new PressingManagementError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found");
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ctx.companyId}::integer, hashtext(${candidate.userId}))`);
        const [assignment] = await tx.select().from(factoryPressingAssignments)
          .where(and(eq(factoryPressingAssignments.id, id), eq(factoryPressingAssignments.companyId, ctx.companyId)))
          .for("update");
        if (!assignment) throw new PressingManagementError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found");
        if (assignment.unassignedAt !== null) return { assignment, unchanged: true };
        const now = new Date();
        await tx.update(factoryPressingSessions).set({ endedAt: now }).where(and(
          eq(factoryPressingSessions.companyId, ctx.companyId), eq(factoryPressingSessions.assignmentId, id),
          isNull(factoryPressingSessions.endedAt)));
        const [ended] = await tx.update(factoryPressingAssignments)
          .set({ unassignedAt: now, unassignedBy: ctx.userId })
          .where(eq(factoryPressingAssignments.id, id)).returning();
        await logAudit({ ...auditActor(req, ctx), action: "permission_change",
          tableName: "factory_pressing_assignments", recordId: id, recordIdentifier: assignment.userId,
          changes: { machineId: { old: assignment.machineId, new: null } } }, tx);
        return { assignment: ended, unchanged: false };
      });
      res.json(result);
    } catch (error) { respondError(res, error); }
  });
}
