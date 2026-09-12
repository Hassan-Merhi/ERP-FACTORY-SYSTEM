/**
 * factoryDocsUsersRoutes: FactoryChat endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { requireSessionUserId } from "../../../lib/sessionUser";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { broadcast } from "../../../wsServer";
import { requireAuth } from "../../../auth";
import { users, directMessages, insertDirectMessageSchema, userPresence } from "@shared/schema";
import { eq, and, or, sql } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";

export function registerFactoryChatRoutes(app: Express) {
  // ============ DIRECT MESSAGES / CHAT ============

  const chatUploadsDir = path.resolve("uploads/chat");
  if (!fs.existsSync(chatUploadsDir)) fs.mkdirSync(chatUploadsDir, { recursive: true });

  const chatStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, chatUploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });
  const chatUpload = multer({ storage: chatStorage, limits: { fileSize: 25 * 1024 * 1024 } });

  const typingStatus = new Map<string, { receiverId: string; until: number }>();

  app.post("/api/chat/upload", requireAuth, chatUpload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const fileUrl = `/uploads/chat/${req.file.filename}`;
      res.json({
        fileUrl,
        fileName: req.file.originalname,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/chat/typing", requireAuth, async (req: Request, res: Response) => {
    try {
      const senderId = requireSessionUserId(req);
      const receiverId = typeof req.body?.receiverId === "string" ? req.body.receiverId : "";
      const isTyping = Boolean(req.body?.isTyping);
      if (!receiverId) return res.status(400).json({ message: "receiverId required" });

      const until = isTyping ? Date.now() + 5000 : null;
      if (isTyping && until) {
        typingStatus.set(senderId, { receiverId, until });
      } else {
        typingStatus.delete(senderId);
      }

      broadcast(
        { type: "typing:update", senderId, receiverId, isTyping, until },
        { userIds: [receiverId] }
      );
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/chat/typing/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = req.session.userId;
      const otherUserId = req.params.userId;
      const record = typingStatus.get(otherUserId);
      const isTyping = !!record && record.receiverId === currentUserId && record.until > Date.now();
      res.json({ isTyping });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/chat/users", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const allUsers = await db
        .select({
          id: users.id,
          username: users.username,
          active: users.active,
        })
        .from(users)
        .where(eq(users.active, true));

      const filtered = allUsers.filter((u) => u.id !== currentUserId);

      // Fetch all presence records in one query
      const presenceRecords = await db.select().from(userPresence);
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

      const usersWithUnread = await Promise.all(
        filtered.map(async (u) => {
          const [unreadResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(directMessages)
            .where(
              and(
                eq(directMessages.senderId, u.id),
                eq(directMessages.receiverId, currentUserId),
                sql`${directMessages.readAt} IS NULL`
              )
            );
          const [msgResult] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(directMessages)
            .where(
              or(
                and(eq(directMessages.senderId, u.id), eq(directMessages.receiverId, currentUserId)),
                and(eq(directMessages.senderId, currentUserId), eq(directMessages.receiverId, u.id))
              )
            );

          // Find most recent presence record for this user
          const userPresenceRecords = presenceRecords.filter((p) => p.userId === u.id);
          const latestPresence = userPresenceRecords.sort(
            (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
          )[0];
          const isOnline = latestPresence ? new Date(latestPresence.lastSeen) > twoMinutesAgo : false;
          const lastSeen = latestPresence ? latestPresence.lastSeen : null;

          return {
            ...u,
            unreadCount: unreadResult?.count || 0,
            hasMessages: (msgResult?.count || 0) > 0,
            isOnline,
            lastSeen,
          };
        })
      );

      res.json(usersWithUnread);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/chat/conversations/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const otherUserId = req.params.userId;

      const messages = await db
        .select()
        .from(directMessages)
        .where(
          or(
            and(eq(directMessages.senderId, currentUserId), eq(directMessages.receiverId, otherUserId)),
            and(eq(directMessages.senderId, otherUserId), eq(directMessages.receiverId, currentUserId))
          )
        )
        .orderBy(directMessages.createdAt);

      res.json(messages);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/chat/messages", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const parsed = insertDirectMessageSchema.parse({
        ...req.body,
        senderId: currentUserId,
      });

      const [msg] = await db
        .insert(directMessages)
        .values({
          senderId: currentUserId,
          receiverId: parsed.receiverId,
          message: parsed.message || null,
          fileUrl: parsed.fileUrl || null,
          fileName: parsed.fileName || null,
          fileType: parsed.fileType || null,
          fileSize: parsed.fileSize || null,
        })
        .returning();

      typingStatus.delete(currentUserId);
      broadcast({ type: "message:new", message: msg }, { userIds: [currentUserId, parsed.receiverId] });
      res.json(msg);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/chat/mark-read/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const senderId = req.params.userId;

      await db
        .update(directMessages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(directMessages.senderId, senderId),
            eq(directMessages.receiverId, currentUserId),
            sql`${directMessages.readAt} IS NULL`
          )
        );

      broadcast({ type: "message:read", readerId: currentUserId, senderId }, { userIds: [currentUserId, senderId] });
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/chat/messages/:userId", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const otherUserId = req.params.userId;

      await db
        .delete(directMessages)
        .where(
          or(
            and(eq(directMessages.senderId, currentUserId), eq(directMessages.receiverId, otherUserId)),
            and(eq(directMessages.senderId, otherUserId), eq(directMessages.receiverId, currentUserId))
          )
        );

      broadcast(
        { type: "conversation:cleared", userIds: [currentUserId, otherUserId] },
        { userIds: [currentUserId, otherUserId] }
      );
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/chat/unread-count", requireAuth, async (req: Request, res: Response) => {
    try {
      const currentUserId = requireSessionUserId(req);
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(directMessages)
        .where(and(eq(directMessages.receiverId, currentUserId), sql`${directMessages.readAt} IS NULL`));
      res.json({ count: result?.count || 0 });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
