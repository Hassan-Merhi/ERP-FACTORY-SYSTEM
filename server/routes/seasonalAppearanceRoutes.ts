/**
 * Developer-managed Christmas Mode. Eligibility is per signed-in user,
 * independent of the active company/workspace. Default access is OFF.
 */
import type { Express } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { systemSettings, users } from "@shared/schema";
import {
  CHRISTMAS_ALLOWED_USERS_KEY,
  CHRISTMAS_MASTER_KEY,
  christmasModeEnabledForUser,
  parseChristmasAllowedUserIds,
} from "../services/seasonalChristmasAccessPolicy";

const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const configSchema = z.object({
  enabled: z.boolean(),
  userIds: z.array(z.string().trim().min(1).max(128)).max(5000),
}).strict();

async function loadChristmasConfig() {
  const rows = await db
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, [CHRISTMAS_MASTER_KEY, CHRISTMAS_ALLOWED_USERS_KEY]));
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const masterValue = settings.get(CHRISTMAS_MASTER_KEY);
  const allowedRaw = settings.get(CHRISTMAS_ALLOWED_USERS_KEY);
  return {
    masterEnabled: masterValue === "true",
    masterValue,
    allowedRaw,
    userIds: parseChristmasAllowedUserIds(allowedRaw),
  };
}

export function registerSeasonalAppearanceRoutes(app: Express): void {
  // All authenticated users can read ONLY their own effective eligibility.
  // The allowlist and master switch never leak through this endpoint.
  app.get("/api/seasonal/christmas-mode", requireAuth, async (req, res) => {
    try {
      const config = await loadChristmasConfig();
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        enabled: christmasModeEnabledForUser(
          config.masterValue,
          config.allowedRaw,
          req.user?.id ?? req.session.userId ?? null,
        ),
      });
    } catch {
      return res.status(500).json({ message: "Unable to load Christmas Mode setting" });
    }
  });

  // Developer-only configuration, including the active-user directory. No
  // passwords, sensitive profiles, company membership or permission data.
  app.get(
    "/api/seasonal/christmas-mode/config",
    requireAuth,
    requireRole("Developer"),
    async (_req, res) => {
      try {
        const [config, activeUsers] = await Promise.all([
          loadChristmasConfig(),
          db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(eq(users.active, true))
            .orderBy(asc(users.username)),
        ]);
        const allowedActiveIds = new Set(activeUsers.map((user) => user.id));
        res.setHeader("Cache-Control", "no-store");
        return res.json({
          enabled: config.masterEnabled,
          userIds: config.userIds.filter((id) => allowedActiveIds.has(id)),
          users: activeUsers,
        });
      } catch {
        return res.status(500).json({ message: "Unable to load Christmas Mode configuration" });
      }
    },
  );

  // Atomically save master status and explicit user allowlist. A user must
  // exist and be active to receive access. No new users are enabled by default.
  app.put(
    "/api/seasonal/christmas-mode/config",
    requireAuth,
    requireRole("Developer"),
    async (req, res) => {
      const parsed = configSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "enabled must be a boolean and userIds must be an array of user IDs" });
      }
      const { enabled } = parsed.data;
      const userIds = [...new Set(parsed.data.userIds)];
      try {
        if (userIds.length > 0) {
          const activeMatches = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.active, true), inArray(users.id, userIds)));
          if (activeMatches.length !== userIds.length) {
            return res.status(400).json({ message: "One or more selected users are missing or inactive" });
          }
        }

        await db.transaction(async (tx) => {
          await tx
            .insert(systemSettings)
            .values({ key: CHRISTMAS_MASTER_KEY, value: String(enabled) })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: String(enabled), updatedAt: new Date() },
            });
          await tx
            .insert(systemSettings)
            .values({ key: CHRISTMAS_ALLOWED_USERS_KEY, value: JSON.stringify(userIds) })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value: JSON.stringify(userIds), updatedAt: new Date() },
            });
        });
        res.setHeader("Cache-Control", "no-store");
        return res.json({ enabled, userIds });
      } catch {
        return res.status(500).json({ message: "Unable to save Christmas Mode configuration" });
      }
    },
  );

  // Backward-compatible Phase 1 endpoint: Developer only. This changes the
  // master flag, never individual access or the allowlist. The new Settings UI
  // uses /config to save both values as one operation.
  app.put(
    "/api/seasonal/christmas-mode",
    requireAuth,
    requireRole("Developer"),
    async (req, res) => {
      const parsed = enabledSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }
      try {
        const enabled = parsed.data.enabled;
        await db
          .insert(systemSettings)
          .values({ key: CHRISTMAS_MASTER_KEY, value: String(enabled) })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: String(enabled), updatedAt: new Date() },
          });
        res.setHeader("Cache-Control", "no-store");
        return res.json({ enabled });
      } catch {
        return res.status(500).json({ message: "Unable to save Christmas Mode setting" });
      }
    },
  );
}
