/**
 * Chat message persistence.
 *
 * Conversation history storage and retrieval for the chat assistant.
 * Extracted from chatService.ts; behaviour is unchanged.
 */
import { db } from "../db";
import { logger } from "../lib/logger";
import * as schema from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";

export async function saveMessage(
  companyId: number,
  userId: string,
  role: "user" | "assistant",
  content: string,
  sessionId: string
): Promise<void> {
  await db.insert(schema.chatMessages).values({
    companyId,
    userId,
    role,
    content,
    sessionId,
  });
}

export async function getConversationHistory(
  sessionId: string,
  userId?: string,
  limit: number = 10
): Promise<{ id: number; role: string; message: string; createdAt: Date }[]> {
  // Filter by sessionId AND userId for security (if userId provided)
  const whereClause = userId
    ? and(eq(schema.chatMessages.sessionId, sessionId), eq(schema.chatMessages.userId, userId))
    : eq(schema.chatMessages.sessionId, sessionId);

  const messages = await db
    .select({
      id: schema.chatMessages.id,
      role: schema.chatMessages.role,
      message: schema.chatMessages.content,
      createdAt: schema.chatMessages.createdAt,
    })
    .from(schema.chatMessages)
    .where(whereClause)
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(limit);

  return messages
    .map((m) => ({ id: m.id, role: m.role ?? "", message: m.message ?? "", createdAt: m.createdAt }))
    .reverse();
}

export async function getConversationHistoryForAI(
  sessionId: string,
  limit: number = 10
): Promise<{ role: string; content: string }[]> {
  const messages = await db
    .select({
      role: schema.chatMessages.role,
      content: schema.chatMessages.content,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(limit);

  return messages.reverse().map((m) => ({ role: m.role || "", content: m.content || "" }));
}

export interface ChatHistoryRow {
  id: number;
  userId: string | null;
  role: string | null;
  content: string | null;
  sessionId: string | null;
  createdAt: Date;
}

export async function getAllChatHistory(companyId: number, limit: number = 100): Promise<ChatHistoryRow[]> {
  const messages = await db
    .select({
      id: schema.chatMessages.id,
      userId: schema.chatMessages.userId,
      role: schema.chatMessages.role,
      content: schema.chatMessages.content,
      sessionId: schema.chatMessages.sessionId,
      createdAt: schema.chatMessages.createdAt,
    })
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.companyId, companyId))
    .orderBy(desc(schema.chatMessages.createdAt))
    .limit(limit);

  return messages;
}

export async function saveFeedback(
  messageId: number,
  feedback: "positive" | "negative",
  userId: string
): Promise<void> {
  logger.info(`Feedback saved: Message ${messageId} - ${feedback} by user ${userId}`);
}
