/**
 * Global seasonal appearance controls shared by every company and workspace.
 * Phase 1 owns the persisted switch only; rendering effects are added later.
 */
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { requireAuth, requireRole } from "../auth";
import { systemSettings } from "@shared/schema";

const KEY = "christmas_mode_enabled";
const settingSchema = z.object({ enabled: z.boolean() }).strict();

export function registerSeasonalAppearanceRoutes(app: Express): void {
  // Any signed-in user, including POS/view-only, can read the global switch.
  // Missing setting means OFF; no per-company row or migration is required.
  app.get("/api/seasonal/christmas-mode", requireAuth, async (_req, res) => {
    try {
      const [setting] = await db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, KEY))
        .limit(1);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ enabled: setting?.value === "true" });
    } catch (_error) {
      return res.status(500).json({ message: "Unable to load Christmas Mode setting" });
    }
  });

  // One master control across all company types. Enforce authorization on
  // the server (not only by hiding/disable the client-side Settings switch).
  app.put(
    "/api/seasonal/christmas-mode",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req, res) => {
      const parsed = settingSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }

      try {
        const enabled = parsed.data.enabled;
        await db
          .insert(systemSettings)
          .values({ key: KEY, value: String(enabled) })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: String(enabled), updatedAt: new Date() },
          });
        res.setHeader("Cache-Control", "no-store");
        return res.json({ enabled });
      } catch (_error) {
        return res.status(500).json({ message: "Unable to save Christmas Mode setting" });
      }
    }
  );
}
