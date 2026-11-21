// Extracted from ./ticketRoutes.ts
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { registerTicketReportingRoutes } from "./ticketReportingRoutes";
import { db } from "../db";
import { requireAuth } from "../auth";
import { requirePageAccess } from "../lib/permissionMiddleware";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { supportTickets, supportTicketNotificationContacts, userCompanyRoles, users, vouchers } from "@shared/schema";
import { storage } from "../storage";
import { buildPermissionMap, canAccess } from "../lib/permissionHelpers";

export function respondError(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : "TICKET_ERROR";
  if (code === "TICKET_NOT_FOUND") return res.status(404).json({ message: "Ticket not found" });
  if (
    code === "TICKET_INVALID_ATTACHMENT" ||
    code === "TICKET_INVALID_COMMENT" ||
    code === "TICKET_RESOLUTION_REQUIRED" ||
    code === "TICKET_REOPEN_REASON_REQUIRED"
  )
    return res.status(400).json({ message: code });
  if (code === "TICKET_ACTION_DENIED")
    return res.status(403).json({ message: "Action is not permitted for this ticket" });
  if (code === "TICKET_ACCESS_DENIED" || code === "TICKET_CREATE_DENIED")
    return res.status(403).json({ message: "Access denied" });
  if (
    code === "TICKET_COMPANY_USER_REQUIRED" ||
    code === "TICKET_VOUCHER_NOT_FOUND" ||
    code === "TICKET_INVALID_VOUCHER"
  ) {
    return res.status(400).json({ message: "Assignee or linked record is not valid in the active company." });
  }
  console.error("[tickets] operation failed", error);
  return res.status(500).json({ message: "Ticket operation failed" });
}

export async function permitted(companyId: number, role: string, key: string): Promise<boolean> {
  if (role === "Developer" || role === "Admin") return true;
  const permissions = await storage.getRoleFeaturePermissions(companyId);
  return canAccess(role, key, buildPermissionMap(permissions, role));
}

const contactInput = z
  .object({
    email: z.union([z.string().trim().email().max(254), z.literal("")]).default(""),
    whatsappNumber: z
      .union([
        z
          .string()
          .trim()
          .regex(/^\\+?[0-9]{7,20}$/),
        z.literal(""),
      ])
      .default(""),
    emailEnabled: z.boolean().default(false),
    whatsappEnabled: z.boolean().default(false),
  })
  .strict()
  .refine((x) => !x.emailEnabled || !!x.email, { message: "Email is required when enabled" })
  .refine((x) => !x.whatsappEnabled || !!x.whatsappNumber, { message: "WhatsApp number is required when enabled" });

export function registerTicketRoutesPart1(app: Express) {
  // Fixed report paths must precede parameterized /:id routes.
  registerTicketReportingRoutes(app);
  const page = [requireAuth, requirePageAccess("page_ticket_management")] as const;

  app.get("/api/tickets/dashboard-access", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const allowed =
        ["Admin", "Developer", "Owner", "Manager"].includes(ctx.role) &&
        (await permitted(ctx.companyId, ctx.role, "act_ticket_manage_all"));
      return res.json({
        canViewDashboard: allowed,
        canExport: allowed && (await permitted(ctx.companyId, ctx.role, "exp_ticket_export")),
      });
    } catch (error) {
      return respondError(res, error);
    }
  });

  // Current-user notification destinations only. No admin enumeration or arbitrary contact assignment.
  app.get("/api/tickets/notification-settings", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const [contact] = await db
        .select({
          email: supportTicketNotificationContacts.email,
          whatsappChatId: supportTicketNotificationContacts.whatsappChatId,
          emailEnabled: supportTicketNotificationContacts.emailEnabled,
          whatsappEnabled: supportTicketNotificationContacts.whatsappEnabled,
        })
        .from(supportTicketNotificationContacts)
        .where(
          and(
            eq(supportTicketNotificationContacts.companyId, ctx.companyId),
            eq(supportTicketNotificationContacts.userId, ctx.userId)
          )
        )
        .limit(1);
      return res.json({
        email: contact?.email ?? "",
        whatsappNumber: contact?.whatsappChatId?.replace(/@c[.]us$/, "") ?? "",
        emailEnabled: contact?.emailEnabled ?? false,
        whatsappEnabled: contact?.whatsappEnabled ?? false,
      });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.put("/api/tickets/notification-settings", ...page, async (req: Request, res: Response) => {
    const input = contactInput.safeParse(req.body);
    if (!input.success)
      return res.status(400).json({ message: "Invalid contact preferences", errors: input.error.flatten() });
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const number = input.data.whatsappNumber.replace(/^\\+/, "");
      await db
        .insert(supportTicketNotificationContacts)
        .values({
          companyId: ctx.companyId,
          userId: ctx.userId,
          email: input.data.email || null,
          whatsappChatId: number ? `${number}@c.us` : null,
          emailEnabled: input.data.emailEnabled,
          whatsappEnabled: input.data.whatsappEnabled,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [supportTicketNotificationContacts.companyId, supportTicketNotificationContacts.userId],
          set: {
            email: input.data.email || null,
            whatsappChatId: number ? `${number}@c.us` : null,
            emailEnabled: input.data.emailEnabled,
            whatsappEnabled: input.data.whatsappEnabled,
            updatedAt: new Date(),
          },
        });
      return res.json({ saved: true });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get("/api/tickets/users", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const matches = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .innerJoin(
          userCompanyRoles,
          and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, ctx.companyId))
        )
        .where(eq(users.active, true))
        .orderBy(users.username)
        .limit(500);
      return res.json({ users: matches });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get("/api/tickets/voucher-search", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      // Search is intentionally limited to actual company vouchers. Broader record types need explicit registry permissions.
      // Voucher discovery is limited to staff with a pre-existing accounting role.
      if (
        !["Admin", "Developer", "Owner", "Manager"].includes(ctx.role) ||
        !(await permitted(ctx.companyId, ctx.role, "page_vouchers"))
      )
        return res.status(403).json({ message: "Voucher search requires accounting access" });
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 80);
      if (q.length < 2) return res.json({ records: [] });
      const escaped = q.replace(/[\\%_]/g, (c) => "\\" + c);
      const records = await db
        .select({ id: vouchers.id, reference: vouchers.voucherNumber, type: vouchers.voucherType })
        .from(vouchers)
        .where(and(eq(vouchers.companyId, ctx.companyId), ilike(vouchers.voucherNumber, `%${escaped}%`)))
        .orderBy(desc(vouchers.id))
        .limit(25);
      return res.json({ records });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.get("/api/tickets", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const pageNumber = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
      const limit = 30;
      const isAdmin =
        ["Admin", "Developer", "Owner", "Manager"].includes(ctx.role) &&
        (await permitted(ctx.companyId, ctx.role, "act_ticket_manage_all"));
      const allowed = isAdmin
        ? sql`true`
        : or(
            eq(supportTickets.createdBy, ctx.userId),
            eq(supportTickets.assignedTo, ctx.userId),
            sql`exists (select 1 from support_ticket_participants p where p.company_id = ${ctx.companyId}
           and p.ticket_id = ${supportTickets.id} and p.user_id = ${ctx.userId})`
          );
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 100);
      const status = String(req.query.status ?? "");
      const filters = [eq(supportTickets.companyId, ctx.companyId), allowed!];
      if (["open", "seen", "working", "finalized", "reopened"].includes(status))
        filters.push(eq(supportTickets.status, status));
      if (q)
        filters.push(
          or(
            ilike(supportTickets.ticketNumber, `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`),
            ilike(supportTickets.title, `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`)
          )!
        );
      const tickets = await db
        .select()
        .from(supportTickets)
        .where(and(...filters))
        .orderBy(desc(supportTickets.createdAt), desc(supportTickets.id))
        .limit(limit)
        .offset((pageNumber - 1) * limit);
      return res.json({ tickets, page: pageNumber, hasMore: tickets.length === limit });
    } catch (error) {
      return respondError(res, error);
    }
  });
  return { page };
}
