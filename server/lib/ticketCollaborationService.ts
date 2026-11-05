import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, type DatabaseOrTransaction } from "../db";
import { supportTickets, supportTicketParticipants, supportTicketAttachments, supportTicketComments, supportTicketEvents, supportTicketOutbox } from "@shared/schema";
import { canAccessTicket, canPerformTicketAction, type TicketActor, type TicketResource, type TicketStatus } from "./ticketPolicy";

import { MAX_TICKET_ATTACHMENT_BYTES, sniffTicketEvidence, safeTicketFileName } from "./ticketEvidenceValidation";

async function ticketResource(tx: DatabaseOrTransaction, actor: TicketActor, ticketId: number): Promise<TicketResource> {
  if (!actor.canAccessPage || !actor.userId || !Number.isSafeInteger(ticketId) || ticketId <= 0) throw new Error("TICKET_ACCESS_DENIED");
  const [t] = await tx.select().from(supportTickets).where(and(
    eq(supportTickets.companyId,actor.companyId), eq(supportTickets.id,ticketId),
  )).limit(1);
  if (!t) throw new Error("TICKET_NOT_FOUND");
  const members = await tx.select({userId:supportTicketParticipants.userId}).from(supportTicketParticipants)
    .where(and(eq(supportTicketParticipants.companyId,actor.companyId),eq(supportTicketParticipants.ticketId,ticketId)));
  const resource:TicketResource = {
    companyId:t.companyId, createdBy:t.createdBy, assignedTo:t.assignedTo,
    participantIds:members.map(x=>x.userId),status:t.status as TicketStatus,
  };
  if (!canAccessTicket(actor,resource)) throw new Error("TICKET_NOT_FOUND");
  return resource;
}

export async function getTicketConversation(actor: TicketActor, ticketId: number) {
  await ticketResource(db,actor,ticketId);
  const [comments,attachments] = await Promise.all([
    db.select({id:supportTicketComments.id,authorId:supportTicketComments.authorId,body:supportTicketComments.body,
      createdAt:supportTicketComments.createdAt})
      .from(supportTicketComments).where(and(eq(supportTicketComments.companyId,actor.companyId),
        eq(supportTicketComments.ticketId,ticketId))).orderBy(asc(supportTicketComments.id)).limit(500),
    db.select({id:supportTicketAttachments.id,fileName:supportTicketAttachments.fileName,
      mimeType:supportTicketAttachments.mimeType,sizeBytes:supportTicketAttachments.sizeBytes,
      uploadedBy:supportTicketAttachments.uploadedBy,createdAt:supportTicketAttachments.createdAt})
      .from(supportTicketAttachments).where(and(eq(supportTicketAttachments.companyId,actor.companyId),
        eq(supportTicketAttachments.ticketId,ticketId))).orderBy(asc(supportTicketAttachments.id)).limit(500),
  ]);
  return {comments,attachments};
}

export async function postTicketComment(actor: TicketActor,ticketId:number,body:string) {
  if (typeof body !== "string" || body.trim().length < 1 || body.length > 10000) throw new Error("TICKET_INVALID_COMMENT");
  return db.transaction(async tx=>{
    const ticket = await ticketResource(tx,actor,ticketId);
    if (!canPerformTicketAction(actor,ticket,"comment")) throw new Error("TICKET_ACTION_DENIED");
    const [comment] = await tx.insert(supportTicketComments).values({
      companyId:actor.companyId,ticketId,authorId:actor.userId,body:body.trim(),
    }).returning();
    await tx.insert(supportTicketEvents).values({
      companyId:actor.companyId,ticketId,actorId:actor.userId,eventType:"comment_added",
      afterState:{commentId:comment.id},
    });
    await tx.insert(supportTicketOutbox).values({
      companyId:actor.companyId,ticketId,eventKey:`ticket:${ticketId}:comment:${comment.id}`,
      eventType:"ticket_comment",payload:{actorId:actor.userId,commentId:comment.id},
    });
    return comment;
  });
}

export async function attachTicketEvidence(actor:TicketActor,ticketId:number,file:{originalname:string;buffer:Buffer}) {
  const mime=sniffTicketEvidence(file.buffer);
  if(!mime) throw new Error("TICKET_INVALID_ATTACHMENT");
  const name=safeTicketFileName(file.originalname);
  return db.transaction(async tx=>{
    const ticket=await ticketResource(tx,actor,ticketId);
    if(!canPerformTicketAction(actor,ticket,"comment")) throw new Error("TICKET_ACTION_DENIED");
    const [attachment]=await tx.insert(supportTicketAttachments).values({
      companyId:actor.companyId,ticketId,uploadedBy:actor.userId,
      storageKey:`db:ticket-evidence:${actor.companyId}:${ticketId}:${createHash("sha256").update(file.buffer).digest("hex")}`,
      fileName:name,mimeType:mime,sizeBytes:file.buffer.length,
      sha256:createHash("sha256").update(file.buffer).digest("hex"),
    }).returning();
    await tx.execute(sql`INSERT INTO support_ticket_attachment_blobs (attachment_id,company_id,content)
      VALUES (${attachment.id},${actor.companyId},${file.buffer})`);
    await tx.insert(supportTicketEvents).values({
      companyId:actor.companyId,ticketId,actorId:actor.userId,eventType:"attachment_added",
      afterState:{attachmentId:attachment.id,fileName:name,mimeType:mime,sizeBytes:file.buffer.length},
    });
    await tx.insert(supportTicketOutbox).values({
      companyId:actor.companyId,ticketId,eventKey:`ticket:${ticketId}:attachment:${attachment.id}`,
      eventType:"ticket_attachment",payload:{actorId:actor.userId,attachmentId:attachment.id},
    });
    return {id:attachment.id,fileName:name,mimeType:mime,sizeBytes:attachment.sizeBytes,uploadedBy:actor.userId,createdAt:attachment.createdAt};
  });
}

export async function getTicketEvidence(actor:TicketActor,ticketId:number,attachmentId:number) {
  await ticketResource(db,actor,ticketId);
  if (!Number.isSafeInteger(attachmentId)||attachmentId<=0) throw new Error("TICKET_NOT_FOUND");
  const [attachment] = await db.select().from(supportTicketAttachments).where(and(
    eq(supportTicketAttachments.companyId,actor.companyId),
    eq(supportTicketAttachments.ticketId,ticketId),
    eq(supportTicketAttachments.id,attachmentId),
  )).limit(1);
  if (!attachment) throw new Error("TICKET_NOT_FOUND");
  const result = await db.execute(sql`SELECT content FROM support_ticket_attachment_blobs
    WHERE attachment_id=${attachmentId} AND company_id=${actor.companyId} LIMIT 1`);
  const bytes = result.rows?.[0]?.content;
  if (!Buffer.isBuffer(bytes)) throw new Error("TICKET_NOT_FOUND");
  return {bytes,mimeType:attachment.mimeType,fileName:attachment.fileName};
}
