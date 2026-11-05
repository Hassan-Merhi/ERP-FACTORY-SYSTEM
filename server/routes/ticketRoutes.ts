import type { Express, Request, Response } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { requireAuth } from "../auth";
import { requirePageAccess, requireActionAccess } from "../lib/permissionMiddleware";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { supportTickets, supportTicketRecords, supportTicketParticipants, userCompanyRoles, users, vouchers } from "@shared/schema";
import { createSupportTicket } from "../lib/ticketService";
import { canAccessTicket } from "../lib/ticketPolicy";

const createSchema = z.object({
  title: z.string().trim().min(3).max(240),
  description: z.string().trim().min(3).max(10000),
  category: z.string().trim().min(2).max(80),
  priority: z.enum(["low","normal","high","urgent"]).default("normal"),
  sourceMode: z.enum(["erp","factory"]),
  assignedTo: z.string().min(1).max(100),
  reportedUserId: z.string().max(100).nullable().optional(),
  voucherId: z.number().int().positive().optional(),
}).strict();

function respondError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : "TICKET_ERROR";
  if (code === "TICKET_ACCESS_DENIED" || code === "TICKET_CREATE_DENIED") return res.status(403).json({ message: "Access denied" });
  if (code === "TICKET_COMPANY_USER_REQUIRED" || code === "TICKET_VOUCHER_NOT_FOUND" || code === "TICKET_INVALID_VOUCHER") {
    return res.status(400).json({ message: "Assignee or linked record is not valid in the active company." });
  }
  console.error("[tickets] operation failed", error);
  return res.status(500).json({ message: "Ticket operation failed" });
}

export function registerTicketRoutes(app: Express) {
  const page = [requireAuth, requirePageAccess("page_ticket_management")] as const;

  app.get("/api/tickets/users", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const matches = await db.select({ id: users.id, username: users.username }).from(users)
        .innerJoin(userCompanyRoles, and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, ctx.companyId)))
        .where(eq(users.active, true)).orderBy(users.username).limit(500);
      return res.json({ users: matches });
    } catch (error) { return respondError(res, error); }
  });

  app.get("/api/tickets/voucher-search", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      // Search is intentionally limited to actual company vouchers. Broader record types need explicit registry permissions.
      // Voucher discovery is limited to staff with a pre-existing accounting role.
      if (!["Admin","Developer","Owner","Manager"].includes(ctx.role)) return res.status(403).json({ message: "Voucher search requires accounting access" });
      const q = String(req.query.q ?? "").trim().slice(0,80);
      if (q.length < 2) return res.json({ records: [] });
      const escaped = q.replace(/[\\%_]/g, c => "\\" + c);
      const records = await db.select({ id: vouchers.id, reference: vouchers.voucherNumber, type: vouchers.voucherType })
        .from(vouchers).where(and(eq(vouchers.companyId,ctx.companyId),ilike(vouchers.voucherNumber,`%${escaped}%`)))
        .orderBy(desc(vouchers.id)).limit(25);
      return res.json({ records });
    } catch (error) { return respondError(res,error); }
  });

  app.get("/api/tickets", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const pageNumber = Math.max(1,Math.min(10000,Number(req.query.page) || 1));
      const limit = 30;
      const isAdmin = ["Admin","Developer","Owner","Manager"].includes(ctx.role);
      const allowed = isAdmin ? sql`true` :
        or(eq(supportTickets.createdBy,ctx.userId),eq(supportTickets.assignedTo,ctx.userId),
          sql`exists (select 1 from support_ticket_participants p where p.company_id = ${ctx.companyId}
           and p.ticket_id = ${supportTickets.id} and p.user_id = ${ctx.userId})`);
      const q = String(req.query.q ?? "").trim().slice(0,100);
      const status = String(req.query.status ?? "");
      const filters = [eq(supportTickets.companyId,ctx.companyId),allowed!];
      if (["open","seen","working","finalized","reopened"].includes(status))
        filters.push(eq(supportTickets.status,status));
      if (q) filters.push(or(ilike(supportTickets.ticketNumber,`%${q.replace(/[\\%_]/g,c=>"\\"+c)}%`),
        ilike(supportTickets.title,`%${q.replace(/[\\%_]/g,c=>"\\"+c)}%`))!);
      const tickets = await db.select().from(supportTickets).where(and(...filters))
        .orderBy(desc(supportTickets.createdAt),desc(supportTickets.id)).limit(limit).offset((pageNumber-1)*limit);
      return res.json({ tickets, page: pageNumber, hasMore: tickets.length === limit });
    } catch (error) { return respondError(res,error); }
  });

  app.get("/api/tickets/:id", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid ticket ID" });
      const [ticket] = await db.select().from(supportTickets)
        .where(and(eq(supportTickets.companyId,ctx.companyId),eq(supportTickets.id,id))).limit(1);
      if (!ticket) return res.status(404).json({ message: "Ticket not found" });
      const participants = await db.select({ userId: supportTicketParticipants.userId })
        .from(supportTicketParticipants).where(and(eq(supportTicketParticipants.companyId,ctx.companyId),eq(supportTicketParticipants.ticketId,id)));
      if (!canAccessTicket({ userId:ctx.userId,companyId:ctx.companyId,role:ctx.role,canAccessPage:true,
          canManageAll:["Admin","Developer","Owner","Manager"].includes(ctx.role) },
        { companyId: ticket.companyId, createdBy: ticket.createdBy, assignedTo: ticket.assignedTo,
          participantIds:participants.map(p=>p.userId),status:ticket.status as "open" })) {
        return res.status(404).json({ message: "Ticket not found" });
      }
      const records = await db.select({ id:supportTicketRecords.id,recordType:supportTicketRecords.recordType,
        displayReference:supportTicketRecords.displayReference })
        .from(supportTicketRecords).where(and(eq(supportTicketRecords.companyId,ctx.companyId),eq(supportTicketRecords.ticketId,id)));
      return res.json({ ticket, records });
    } catch (error) { return respondError(res,error); }
  });

  app.post("/api/tickets", ...page, requireActionAccess("act_ticket_create"), async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message:"Invalid ticket", errors:parsed.error.flatten() });
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      if (["View Only","POS"].includes(ctx.role)) return res.status(403).json({ message:"Ticket creation disabled for role" });
      if (parsed.data.voucherId && !["Admin","Developer","Owner","Manager"].includes(ctx.role))
        return res.status(403).json({ message:"Voucher linking requires accounting access" });
      const ticket = await createSupportTicket({ userId:ctx.userId, companyId:ctx.companyId, role:ctx.role,
        canAccessPage:true,canCreate:true },parsed.data);
      return res.status(201).json({ ticket });
    } catch (error) { return respondError(res,error); }
  });
}
