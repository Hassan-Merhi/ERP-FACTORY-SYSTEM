import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { ticketCreateSchema } from "../lib/ticketInputs";
import { db } from "../db";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { supportTickets, supportTicketRecords, supportTicketParticipants } from "@shared/schema";
import { createSupportTicket, transitionSupportTicket } from "../lib/ticketService";
import {
  attachTicketEvidence,
  getTicketEvidence,
  getTicketConversation,
  postTicketComment,
} from "../lib/ticketCollaborationService";
import { canAccessTicket, canPerformTicketAction, type TicketStatus } from "../lib/ticketPolicy";
import { MAX_TICKET_ATTACHMENT_BYTES } from "../lib/ticketEvidenceValidation";
import { registerTicketRoutesPart1, respondError, permitted } from "./registerTicketRoutesPart1";

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

export function registerTicketRoutes(app: Express) {
  const { page } = registerTicketRoutesPart1(app);

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
