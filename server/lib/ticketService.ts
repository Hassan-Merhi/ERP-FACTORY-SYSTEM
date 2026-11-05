import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { supportTickets, supportTicketEvents, supportTicketOutbox, supportTicketParticipants, users, userCompanyRoles } from "@shared/schema";
import { canAccessTicket, transitionTicket, type TicketActor, type TicketStatus } from "./ticketPolicy";

async function requireActiveCompanyUser(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], companyId: number, userId: string): Promise<void> {
  const [found] = await tx.select({ id: users.id }).from(users)
    .innerJoin(userCompanyRoles, and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, companyId)))
    .where(and(eq(users.id, userId), eq(users.active, true))).limit(1);
  if (!found) throw new Error("TICKET_COMPANY_USER_REQUIRED");
}

function assertActor(actor: TicketActor) {
  if (!actor.userId || !Number.isInteger(actor.companyId) || actor.companyId <= 0 || !actor.canAccessPage) {
    throw new Error("TICKET_ACCESS_DENIED");
  }
}

/** A service boundary, not an HTTP endpoint: callers must resolve the authenticated actor. */
export async function createSupportTicket(
  actor: TicketActor,
  input: { assignedTo: string; category: string; priority: "low" | "normal" | "high" | "urgent";
    sourceMode: "erp" | "factory"; title: string; description: string; reportedUserId?: string | null },
) {
  assertActor(actor);
  if (actor.canCreate === false) throw new Error("TICKET_CREATE_DENIED");
  if (!input.title.trim() || !input.description.trim() || !input.category.trim()) throw new Error("TICKET_FIELDS_REQUIRED");
  return db.transaction(async (tx) => {
    await requireActiveCompanyUser(tx, actor.companyId, actor.userId);
    await requireActiveCompanyUser(tx, actor.companyId, input.assignedTo);
    if (input.reportedUserId) await requireActiveCompanyUser(tx, actor.companyId, input.reportedUserId);
    // Sequence-backed ticket ID is globally unique, displayed numbers remain company scoped.
    const [ticket] = await tx.insert(supportTickets).values({
      companyId: actor.companyId, ticketNumber: `PENDING-${randomUUID()}`,
      sourceMode: input.sourceMode, category: input.category.trim(), priority: input.priority,
      status: "open", title: input.title.trim(), description: input.description.trim(),
      createdBy: actor.userId, assignedTo: input.assignedTo, reportedUserId: input.reportedUserId ?? null,
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).returning();
    const ticketNumber = `TKT-${new Date(ticket.createdAt).getUTCFullYear()}-${String(ticket.id).padStart(6, "0")}`;
    const [saved] = await tx.update(supportTickets).set({ ticketNumber }).where(eq(supportTickets.id,ticket.id)).returning();
    await tx.insert(supportTicketEvents).values({
      ticketId: saved.id, companyId: actor.companyId, actorId: actor.userId,
      eventType: "created", afterState: { status: "open", assignedTo: input.assignedTo },
    });
    await tx.insert(supportTicketOutbox).values({
      ticketId: saved.id, companyId: actor.companyId, eventKey: `ticket:${saved.id}:created`,
      eventType: "ticket_created", payload: { assigneeId: input.assignedTo },
    });
    return saved;
  });
}

export async function transitionSupportTicket(
  actor: TicketActor, ticketId: number, action: "seen" | "start" | "finalize" | "reopen",
  details: { resolutionNote?: string; reason?: string } = {},
) {
  assertActor(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(supportTickets)
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.companyId, actor.companyId)))
      .for("update");
    if (!current) throw new Error("TICKET_NOT_FOUND");
    const participants = await tx.select({ userId: supportTicketParticipants.userId })
      .from(supportTicketParticipants).where(and(eq(supportTicketParticipants.companyId, actor.companyId),
        eq(supportTicketParticipants.ticketId, ticketId)));
    const resource = { companyId: current.companyId, createdBy: current.createdBy,
      assignedTo: current.assignedTo, participantIds: participants.map(p=>p.userId), status: current.status as TicketStatus };
    if (!canAccessTicket(actor,resource)) throw new Error("TICKET_ACCESS_DENIED");
    const next = transitionTicket(actor,resource,action,details);
    const now = new Date();
    const updates = {
      status: next, updatedAt: now, version: current.version + 1,
      ...(action === "seen" ? { firstSeenAt: current.firstSeenAt ?? now } : {}),
      ...(action === "start" ? { startedAt: now } : {}),
      ...(action === "finalize" ? { finalizedAt: now, finalizedBy: actor.userId, resolutionNote: details.resolutionNote!.trim() } : {}),
      ...(action === "reopen" ? { finalizedAt: null, finalizedBy: null, reopenedCount: current.reopenedCount + 1 } : {}),
    };
    const [saved] = await tx.update(supportTickets).set(updates).where(eq(supportTickets.id,ticketId)).returning();
    await tx.insert(supportTicketEvents).values({
      ticketId, companyId: actor.companyId, actorId: actor.userId, eventType: action,
      beforeState: { status: current.status, version: current.version },
      afterState: { status: next, version: saved.version },
      reason: action === "reopen" ? details.reason!.trim() : action === "finalize" ? details.resolutionNote!.trim() : null,
    });
    await tx.insert(supportTicketOutbox).values({
      ticketId, companyId: actor.companyId, eventKey: `ticket:${ticketId}:version:${saved.version}`,
      eventType: `ticket_${action}`, payload: { actorId: actor.userId, status: next },
    });
    return saved;
  });
}
