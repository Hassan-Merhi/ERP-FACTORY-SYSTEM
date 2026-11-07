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
  CHRISTMAS_VISUALS_KEY,
  christmasModeEnabledForUser,
  parseChristmasVisualSettings,
  christmasModeUserPreferenceKey,
  parseChristmasAllowedUserIds,
} from "../services/seasonalChristmasAccessPolicy";

const enabledSchema = z.object({ enabled: z.boolean() }).strict();
const visualSchema = z
  .object({
    intensity: z.enum(["subtle", "balanced", "full"]),
    effects: z
      .object({
        snowfall: z.boolean(),
        santa: z.boolean(),
        garlands: z.boolean(),
        countdown: z.boolean(),
        gifts: z.boolean(),
        ambient: z.boolean(),
      })
      .strict(),
  })
  .strict();
const configSchema = z
  .object({
    enabled: z.boolean(),
    userIds: z.array(z.string().trim().min(1).max(128)).max(5000),
    visuals: visualSchema.optional(),
  })
  .strict();

async function loadChristmasConfig(userId?: string | null) {
  const keys = [CHRISTMAS_MASTER_KEY, CHRISTMAS_ALLOWED_USERS_KEY, CHRISTMAS_VISUALS_KEY];
  if (userId) keys.push(christmasModeUserPreferenceKey(userId));
  const rows = await db
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, keys));
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const masterValue = settings.get(CHRISTMAS_MASTER_KEY);
  const allowedRaw = settings.get(CHRISTMAS_ALLOWED_USERS_KEY);
  return {
    masterEnabled: masterValue === "true",
    masterValue,
    allowedRaw,
    userIds: parseChristmasAllowedUserIds(allowedRaw),
    visuals: parseChristmasVisualSettings(settings.get(CHRISTMAS_VISUALS_KEY)),
    // Existing eligible users keep the experience ON unless they personally opt out.
    preferenceEnabled: userId ? settings.get(christmasModeUserPreferenceKey(userId)) !== "false" : true,
  };
}

export function registerSeasonalAppearanceRoutes(app: Express): void {
  // All authenticated users can read ONLY their own effective eligibility.
  // The allowlist and master switch never leak through this endpoint.
  app.get("/api/seasonal/christmas-mode", requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id ?? req.session.userId ?? null;
      const config = await loadChristmasConfig(userId);
      const available = Boolean(userId && config.userIds.includes(userId));
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        enabled: christmasModeEnabledForUser(config.masterValue, config.allowedRaw, userId, config.preferenceEnabled),
        available,
        preferenceEnabled: available ? config.preferenceEnabled : false,
        visuals: available ? config.visuals : null,
      });
    } catch {
      return res.status(500).json({ message: "Unable to load Christmas Mode setting" });
    }
  });

  // Each allowlisted user can opt out without changing Developer-granted access.
  // This per-account choice is shared between all companies and devices.
  app.put("/api/seasonal/christmas-mode/preference", requireAuth, async (req, res) => {
    const parsed = enabledSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "enabled must be a boolean" });
    const userId = req.user?.id ?? req.session.userId ?? null;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    try {
      const config = await loadChristmasConfig(userId);
      if (!config.userIds.includes(userId)) {
        return res.status(403).json({ message: "Christmas Mode is not available for your account" });
      }
      const preferenceEnabled = parsed.data.enabled;
      await db
        .insert(systemSettings)
        .values({ key: christmasModeUserPreferenceKey(userId), value: String(preferenceEnabled) })
        .onConflictDoUpdate({
          target: systemSettings.key,
          set: { value: String(preferenceEnabled), updatedAt: new Date() },
        });
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        available: true,
        preferenceEnabled,
        enabled: config.masterEnabled && preferenceEnabled,
        visuals: config.visuals,
      });
    } catch {
      return res.status(500).json({ message: "Unable to save your Christmas Mode preference" });
    }
  });

  // Developer-only configuration, including the active-user directory. No
  // passwords, sensitive profiles, company membership or permission data.
  app.get("/api/seasonal/christmas-mode/config", requireAuth, requireRole("Developer"), async (_req, res) => {
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
        visuals: config.visuals,
      });
    } catch {
      return res.status(500).json({ message: "Unable to load Christmas Mode configuration" });
    }
  });

  // Atomically save master status and explicit user allowlist. A user must
  // exist and be active to receive access. No new users are enabled by default.
  app.put("/api/seasonal/christmas-mode/config", requireAuth, requireRole("Developer"), async (req, res) => {
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
        // Optional for backward compatibility with old developer clients.
        if (parsed.data.visuals) {
          const value = JSON.stringify(parsed.data.visuals);
          await tx
            .insert(systemSettings)
            .values({ key: CHRISTMAS_VISUALS_KEY, value })
            .onConflictDoUpdate({
              target: systemSettings.key,
              set: { value, updatedAt: new Date() },
            });
        }
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ enabled, userIds, visuals: parsed.data.visuals ?? (await loadChristmasConfig()).visuals });
    } catch {
      return res.status(500).json({ message: "Unable to save Christmas Mode configuration" });
    }
  });

  // Backward-compatible Phase 1 endpoint: Developer only. This changes the
  // master flag, never individual access or the allowlist. The new Settings UI
  // uses /config to save both values as one operation.
  app.put("/api/seasonal/christmas-mode", requireAuth, requireRole("Developer"), async (req, res) => {
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
  });
}
