import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { ticketCreateSchema } from "../lib/ticketInputs";
import { registerTicketReportingRoutes } from "./ticketReportingRoutes";
import { db } from "../db";
import { requireAuth } from "../auth";
import { requirePageAccess, requireActionAccess } from "../lib/permissionMiddleware";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import {
  supportTickets,
  supportTicketRecords,
  supportTicketParticipants,
  supportTicketNotificationContacts,
  userCompanyRoles,
  users,
  vouchers,
} from "@shared/schema";
import { createSupportTicket, transitionSupportTicket } from "../lib/ticketService";
import {
  attachTicketEvidence,
  getTicketEvidence,
  getTicketConversation,
  postTicketComment,
} from "../lib/ticketCollaborationService";
import { canAccessTicket, canPerformTicketAction, type TicketStatus } from "../lib/ticketPolicy";
import { storage } from "../storage";
import { MAX_TICKET_ATTACHMENT_BYTES } from "../lib/ticketEvidenceValidation";
import { buildPermissionMap, canAccess } from "../lib/permissionHelpers";

function respondError(res: Response, error: unknown) {
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

async function permitted(companyId: number, role: string, key: string): Promise<boolean> {
  if (role === "Developer" || role === "Admin") return true;
  const permissions = await storage.getRoleFeaturePermissions(companyId);
  return canAccess(role, key, buildPermissionMap(permissions, role));
}

const uploadTicketEvidence = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TICKET_ATTACHMENT_BYTES, files: 1, fields: 0 },
}).single("file");

function positiveId(raw: string): number {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : NaN;
}

async function actorForTicket(req: Request) {
  const ctx = await getActiveCompanyPermissionContext(req);
  const isPrivileged = ["Admin", "Developer", "Owner", "Manager"].includes(ctx.role);
  const manage = isPrivileged && (await permitted(ctx.companyId, ctx.role, "act_ticket_manage_all"));
  return {
    userId: ctx.userId,
    companyId: ctx.companyId,
    role: ctx.role,
    canAccessPage: true,
    canManageAll: manage,
    canFinalize: await permitted(ctx.companyId, ctx.role, "act_ticket_finalize"),
    canReopen: await permitted(ctx.companyId, ctx.role, "act_ticket_reopen"),
  };
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

export function registerTicketRoutes(app: Express) {
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

  app.get("/api/tickets/:id", ...page, async (req: Request, res: Response) => {
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid ticket ID" });
      const [ticket] = await db
        .select()
        .from(supportTickets)
        .where(and(eq(supportTickets.companyId, ctx.companyId), eq(supportTickets.id, id)))
        .limit(1);
      if (!ticket) return res.status(404).json({ message: "Ticket not found" });
      const participants = await db
        .select({ userId: supportTicketParticipants.userId })
        .from(supportTicketParticipants)
        .where(and(eq(supportTicketParticipants.companyId, ctx.companyId), eq(supportTicketParticipants.ticketId, id)));
      const actor = await actorForTicket(req);
      const resource = {
        companyId: ticket.companyId,
        createdBy: ticket.createdBy,
        assignedTo: ticket.assignedTo,
        participantIds: participants.map((p) => p.userId),
        status: ticket.status as TicketStatus,
      };
      if (!canAccessTicket(actor, resource)) return res.status(404).json({ message: "Ticket not found" });
      const capabilities = {
        seen: canPerformTicketAction(actor, resource, "seen"),
        start: canPerformTicketAction(actor, resource, "start"),
        finalize: canPerformTicketAction(actor, resource, "finalize"),
        reopen: canPerformTicketAction(actor, resource, "reopen"),
      };
      const records = await db
        .select({
          id: supportTicketRecords.id,
          recordType: supportTicketRecords.recordType,
          displayReference: supportTicketRecords.displayReference,
        })
        .from(supportTicketRecords)
        .where(and(eq(supportTicketRecords.companyId, ctx.companyId), eq(supportTicketRecords.ticketId, id)));
      return res.json({ ticket, records, capabilities });
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post("/api/tickets", ...page, requireActionAccess("act_ticket_create"), async (req: Request, res: Response) => {
    const parsed = ticketCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid ticket", errors: parsed.error.flatten() });
    try {
      const ctx = await getActiveCompanyPermissionContext(req);
      if (["View Only", "Create Only", "POS"].includes(ctx.role))
        return res.status(403).json({ message: "Ticket creation disabled for role" });
      if (
        parsed.data.voucherId &&
        (!["Admin", "Developer", "Owner", "Manager"].includes(ctx.role) ||
          !(await permitted(ctx.companyId, ctx.role, "page_vouchers")))
      )
        return res.status(403).json({ message: "Voucher linking requires accounting access" });
      const ticket = await createSupportTicket(
        { userId: ctx.userId, companyId: ctx.companyId, role: ctx.role, canAccessPage: true, canCreate: true },
        parsed.data
      );
      return res.status(201).json({ ticket });
    } catch (error) {
      return respondError(res, error);
    }
  });
  // Phase 3: comments and evidence. Every read/write re-checks the active company and ticket membership.
  app.get("/api/tickets/:id/conversation", ...page, async (req: Request, res: Response) => {
    try {
      const id = positiveId(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid ticket ID" });
      return res.json(await getTicketConversation(await actorForTicket(req), id));
    } catch (error) {
      return respondError(res, error);
    }
  });

  app.post(
    "/api/tickets/:id/comments",
    ...page,
    requireActionAccess("act_ticket_comment"),
    async (req: Request, res: Response) => {
      try {
        const id = positiveId(req.params.id);
        if (!id) return res.status(400).json({ message: "Invalid ticket ID" });
        const comment = await postTicketComment(await actorForTicket(req), id, req.body?.body);
        return res.status(201).json({ comment });
      } catch (error) {
        return respondError(res, error);
      }
    }
  );

  app.post(
    "/api/tickets/:id/attachments",
    ...page,
    requireActionAccess("act_ticket_comment"),
    (req: Request, res: Response, next) => {
      uploadTicketEvidence(req, res, (error) => {
        if (error)
          return res
            .status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
            .json({ message: "Upload rejected. Maximum 5 MB photo or PDF." });
        next();
      });
    },
    async (req: Request, res: Response) => {
      try {
        const id = positiveId(req.params.id);
        if (!id) return res.status(400).json({ message: "Invalid ticket ID" });
        if (!req.file) return res.status(400).json({ message: "File is required" });
        const attachment = await attachTicketEvidence(await actorForTicket(req), id, req.file);
        return res.status(201).json({ attachment });
      } catch (error) {
        return respondError(res, error);
      }
    }
  );

  app.get("/api/tickets/:id/attachments/:attachmentId", ...page, async (req: Request, res: Response) => {
    try {
      const id = positiveId(req.params.id),
        attachmentId = positiveId(req.params.attachmentId);
      if (!id || !attachmentId) return res.status(400).json({ message: "Invalid attachment" });
      const file = await getTicketEvidence(await actorForTicket(req), id, attachmentId);
      const asciiName =
        file.fileName
          .replace(/[^\x20-\x7e]/g, "_")
          .replace(/["\\]/g, "_")
          .slice(0, 160) || "attachment";
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader(
        "Content-Disposition",
        `${file.mimeType.startsWith("image/") ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      // Ticket evidence is validated as binary image/PDF before storage.
      // Prevent active content from executing if a browser opens an attachment.
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      // Stream validated binary evidence; never render user content as HTML.
      res.setHeader("Content-Length", String(file.bytes.length));
      Readable.from([file.bytes]).pipe(res);
      return;
    } catch (error) {
      return respondError(res, error);
    }
  });

  for (const [action, permission] of [
    ["seen", null],
    ["start", null],
    ["finalize", "act_ticket_finalize"],
    ["reopen", "act_ticket_reopen"],
  ] as const) {
    const middleware = permission ? [requireActionAccess(permission)] : [];
    app.post(`/api/tickets/:id/${action}`, ...page, ...middleware, async (req: Request, res: Response) => {
      try {
        const id = positiveId(req.params.id);
        if (!id) return res.status(400).json({ message: "Invalid ticket ID" });
        const resolutionNote =
          typeof req.body?.resolutionNote === "string" ? req.body.resolutionNote.slice(0, 10000) : undefined;
        const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 10000) : undefined;
        const ticket = await transitionSupportTicket(await actorForTicket(req), id, action, { resolutionNote, reason });
        return res.json({ ticket });
      } catch (error) {
        return respondError(res, error);
      }
    });
  }
}
