import { getErrorDetails } from "@shared/errorUtils";
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db, pool } from "../../db";
import { storage } from "../../storage";
import { requireAuth, checkPOSLocation } from "../../auth";
import { requireExportAccess } from "../../lib/permissionMiddleware";
import { logAudit } from "../_helpers";
import { locations, insertLocationSchema } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import {
  fetchGreenApiChats,
  getPosWaSettings,
  sendWhatsAppTextToChatIdPos,
  type GreenChat,
} from "../../services/whatsappService";
import { parseMoneyInput } from "../../lib/money";

const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";

type LocationWhatsAppSettings = {
  whatsappGroupChatId: string | null;
  whatsappGroupName: string | null;
  whatsappStockReportsEnabled: boolean;
};

async function getLocationWhatsAppSettingsMap(companyId: number): Promise<Map<number, LocationWhatsAppSettings>> {
  try {
    const result = await pool.query(
      `SELECT location_id, whatsapp_group_chat_id, whatsapp_group_name, enabled
         FROM location_whatsapp_stock_reports
        WHERE company_id = $1`,
      [companyId]
    );
    return new Map(
      result.rows.map((row) => [
        Number(row.location_id),
        {
          whatsappGroupChatId: row.whatsapp_group_chat_id ?? null,
          whatsappGroupName: row.whatsapp_group_name ?? null,
          whatsappStockReportsEnabled: row.enabled === true,
        },
      ])
    );
  } catch (error) {
    // Startup migrations create this table before routes are served. Keeping the
    // fallback makes older test fixtures and partially migrated dev databases
    // readable instead of turning the whole Location Inventory page into a 500.
    if (getErrorDetails(error).code === "42P01") return new Map();
    throw error;
  }
}

function withLocationWhatsAppSettings(location: Record<string, unknown>, settings?: LocationWhatsAppSettings) {
  const legacyChatId = location.whatsappGroupChatId ?? null;
  return {
    ...location,
    whatsappGroupChatId: settings?.whatsappGroupChatId ?? legacyChatId,
    whatsappGroupName: settings?.whatsappGroupName ?? null,
    whatsappStockReportsEnabled: settings?.whatsappStockReportsEnabled ?? Boolean(legacyChatId),
  };
}

async function resolveVerifiedWhatsAppGroup(chatId: string): Promise<GreenChat> {
  const normalized = chatId.trim();
  if (!normalized.endsWith("@g.us")) {
    throw new Error("A WhatsApp group must be selected");
  }

  const settings = await getPosWaSettings();
  if (!settings?.instanceId || !settings?.apiToken) {
    throw new Error("WhatsApp credentials are not configured");
  }

  const chats = await fetchGreenApiChats(settings.instanceId, settings.apiToken);
  const group = chats.find((chat) => chat.id === normalized && (chat.type === "group" || chat.id.endsWith("@g.us")));
  if (!group) {
    throw new Error("The selected WhatsApp group is no longer available on the connected account");
  }
  return group;
}

export function registerLocationCrudRoutes(app: Express) {
  app.get("/api/locations", requireAuth, async (req, res) => {
    try {
      const companyId = req.query.companyId ? parseInt(req.query.companyId as string) : req.session.currentCompanyId;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected or specified" });
      }

      const [companyLocations, whatsappSettings] = await Promise.all([
        storage.getAllLocations(companyId),
        getLocationWhatsAppSettingsMap(companyId),
      ]);
      res.json(
        companyLocations.map((location) => withLocationWhatsAppSettings(location, whatsappSettings.get(location.id)))
      );
    } catch (error: unknown) {
      logger.error("[/api/locations] Error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Capability probe used by the Location Inventory UI. It intentionally goes
  // through the same permission middleware as every WhatsApp management write.
  app.get(
    "/api/location-inventory/whatsapp/capability",
    requireAuth,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (_req, res) => {
      res.json({ canManage: true });
    }
  );

  // Dedicated group picker for Location Inventory. Only groups from the same
  // WhatsApp instance used by POS/location messaging are returned; contacts are
  // excluded so a stock report cannot accidentally be configured to a person.
  app.get(
    "/api/location-inventory/whatsapp/groups",
    requireAuth,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (_req, res) => {
      try {
        const settings = await getPosWaSettings();
        if (!settings?.instanceId || !settings?.apiToken) {
          return res.status(400).json({ message: "WhatsApp credentials are not configured" });
        }
        const chats = await fetchGreenApiChats(settings.instanceId, settings.apiToken);
        res.json(chats.filter((chat) => chat.type === "group" || chat.id.endsWith("@g.us")));
      } catch (error: unknown) {
        res.status(502).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/locations", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const parsed = insertLocationSchema.parse({
        ...req.body,
        companyId: req.session.currentCompanyId,
      });

      // Auto-generate code from name if not provided
      if (!parsed.code) {
        // Generate code from name: remove non-alphanumeric, take first 6 letters, uppercase
        const sanitized = parsed.name.trim().replace(/[^a-zA-Z0-9]/g, "");
        let baseCode = sanitized.substring(0, 6).toUpperCase();

        // Fallback if baseCode is empty after sanitization
        if (!baseCode || baseCode.length === 0) {
          baseCode = "LOC";
        }

        // Ensure uniqueness by adding suffix if needed
        let code = baseCode;
        let suffix = 1;
        while (await storage.getLocationByCode(code, req.session.currentCompanyId)) {
          code = `${baseCode}${suffix}`;
          suffix++;
        }
        parsed.code = code;
      } else {
        // Check for duplicate code if manually provided
        const existing = await storage.getLocationByCode(parsed.code, req.session.currentCompanyId);
        if (existing) {
          return res.status(400).json({ message: "Location code already exists" });
        }
      }

      // Provide defaults for optional fields
      const locationData = {
        ...parsed,
        code: parsed.code!,
        city: parsed.city || "",
        state: parsed.state || "",
        country: parsed.country || "",
      };

      // Phase 21 (B): the write and its audit commit together.
      const location = await db.transaction(async (tx) => {
        const written = await storage.createLocation(locationData, tx);
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "create",
            tableName: "locations",
            recordId: written.id,
            recordIdentifier: written.name,
            changes: {
              name: { old: null, new: written.name },
              code: { old: null, new: written.code },
              city: { old: null, new: written.city || null },
              state: { old: null, new: written.state || null },
              country: { old: null, new: written.country || null },
            },
          },
          tx
        );
        return written;
      });
      res.status(201).json(location);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Get single location by ID
  app.get("/api/locations/:locationId", requireAuth, checkPOSLocation, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location) {
        return res.status(404).json({ message: "Location not found" });
      }

      // Verify location belongs to current company
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Location belongs to a different company",
        });
      }

      const settingsMap = await getLocationWhatsAppSettingsMap(location.companyId);
      res.json(withLocationWhatsAppSettings(location, settingsMap.get(location.id)));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Rename (update) location. WhatsApp destination changes intentionally use the
  // dedicated permission-protected endpoint below so this generic route cannot
  // be used to bypass the location WhatsApp management permission.
  app.patch("/api/locations/:locationId", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const location = await storage.getLocationById(locationId);
      if (!location) return res.status(404).json({ message: "Location not found" });
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (
        req.body.whatsappGroupChatId !== undefined ||
        req.body.whatsappGroupName !== undefined ||
        req.body.whatsappStockReportsEnabled !== undefined
      ) {
        return res.status(400).json({
          message: "Use the location WhatsApp settings endpoint to change WhatsApp reporting configuration",
        });
      }

      const { name, transferWaGroupChatId, supplierPartnerPayableDeductionPerQty } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "name is required" });
      }

      const updatePayload: Record<string, unknown> = { name: name.trim() };
      if (transferWaGroupChatId !== undefined) {
        updatePayload.transferWaGroupChatId = transferWaGroupChatId || null;
      }
      if (supplierPartnerPayableDeductionPerQty !== undefined) {
        const deductionVal = parseMoneyInput(supplierPartnerPayableDeductionPerQty)?.toNumber() ?? NaN;
        if (isNaN(deductionVal) || deductionVal < 0) {
          return res.status(400).json({ message: "supplierPartnerPayableDeductionPerQty must be >= 0" });
        }
        updatePayload.supplierPartnerPayableDeductionPerQty = deductionVal.toFixed(4);
      }

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx.update(locations).set(updatePayload).where(eq(locations.id, locationId)).returning();

        const _locChanges: Record<string, { old?: unknown; new?: unknown }> = {};
        if (location.name !== written.name) _locChanges.name = { old: location.name, new: written.name };
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "update",
            tableName: "locations",
            recordId: written.id,
            recordIdentifier: written.name,
            changes: _locChanges,
          },
          tx
        );
        return written;
      });
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Save the WhatsApp stock-report destination for one location. The selected
  // group is re-resolved from Green API server-side; the client cannot inject an
  // arbitrary contact/chat ID or spoof the stored group name.
  app.put(
    "/api/locations/:locationId/whatsapp-settings",
    requireAuth,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const requestedChatId =
          typeof req.body.whatsappGroupChatId === "string" && req.body.whatsappGroupChatId.trim()
            ? req.body.whatsappGroupChatId.trim()
            : null;
        const enabled = req.body.enabled === true;

        if (enabled && !requestedChatId) {
          return res.status(400).json({ message: "Link a WhatsApp group before enabling stock reports" });
        }

        const group = requestedChatId ? await resolveVerifiedWhatsAppGroup(requestedChatId) : null;
        const oldSettings = (await getLocationWhatsAppSettingsMap(companyId)).get(locationId);

        const updatedSettings: LocationWhatsAppSettings = {
          whatsappGroupChatId: group?.id ?? null,
          whatsappGroupName: group?.name ?? null,
          whatsappStockReportsEnabled: enabled,
        };

        // Phase 21 (B): the settings, the location's group and the audit row
        // commit together (a pooled client transaction with an after-commit,
        // non-fatal audit before).
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO location_whatsapp_stock_reports (
              location_id, company_id, whatsapp_group_chat_id, whatsapp_group_name, enabled, updated_at
            )
            VALUES (${locationId}, ${companyId}, ${group?.id ?? null}, ${group?.name ?? null}, ${enabled}, now())
            ON CONFLICT (location_id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              whatsapp_group_chat_id = EXCLUDED.whatsapp_group_chat_id,
              whatsapp_group_name = EXCLUDED.whatsapp_group_name,
              enabled = EXCLUDED.enabled,
              updated_at = now()
          `);
          // Keep the existing location destination in sync because POS/revision
          // flows already rely on this field for the same location WhatsApp group.
          await tx.execute(sql`
            UPDATE locations
               SET whatsapp_group_chat_id = ${group?.id ?? null}
             WHERE id = ${locationId} AND company_id = ${companyId}
          `);
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update_location_whatsapp_stock_reports",
              tableName: "location_whatsapp_stock_reports",
              recordId: locationId,
              recordIdentifier: location.name,
              changes: {
                whatsappGroupChatId: {
                  old: oldSettings?.whatsappGroupChatId ?? location.whatsappGroupChatId ?? null,
                  new: updatedSettings.whatsappGroupChatId,
                },
                whatsappGroupName: {
                  old: oldSettings?.whatsappGroupName ?? null,
                  new: updatedSettings.whatsappGroupName,
                },
                enabled: {
                  old: oldSettings?.whatsappStockReportsEnabled ?? Boolean(location.whatsappGroupChatId),
                  new: enabled,
                },
              },
            },
            tx
          );
        });

        res.json(
          withLocationWhatsAppSettings({ ...location, whatsappGroupChatId: group?.id ?? null }, updatedSettings)
        );
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.includes("WhatsApp") || message.includes("selected") || message.includes("group")) {
          return res.status(400).json({ message });
        }
        logger.error("[location-whatsapp-settings] Error", { error });
        res.status(500).json({ message });
      }
    }
  );

  // Sends a harmless text-only test to the currently selected group. If the UI
  // passes a not-yet-saved group, it is revalidated against the connected account
  // before sending so this route cannot be used as an arbitrary WhatsApp sender.
  app.post(
    "/api/locations/:locationId/whatsapp-test",
    requireAuth,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const requestedChatId =
          typeof req.body.whatsappGroupChatId === "string" && req.body.whatsappGroupChatId.trim()
            ? req.body.whatsappGroupChatId.trim()
            : null;
        const stored = (await getLocationWhatsAppSettingsMap(companyId)).get(locationId);
        const chatId = requestedChatId ?? stored?.whatsappGroupChatId ?? location.whatsappGroupChatId ?? null;
        if (!chatId) return res.status(400).json({ message: "No WhatsApp group is linked to this location" });

        const group = await resolveVerifiedWhatsAppGroup(chatId);
        const result = await sendWhatsAppTextToChatIdPos(
          group.id,
          `✅ Location Inventory WhatsApp test\nLocation: ${location.name}\nGroup: ${group.name}\nThe connection is working.`
        );
        if (!result.success) {
          return res.status(502).json({ message: result.error || "WhatsApp test send failed" });
        }

        try {
          await logAudit({
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "test_location_whatsapp",
            tableName: "location_whatsapp_stock_reports",
            recordId: locationId,
            recordIdentifier: location.name,
            changes: {
              whatsappGroupChatId: { old: null, new: group.id },
              whatsappGroupName: { old: null, new: group.name },
            },
          });
        } catch {
          /* non-fatal */
        }

        res.json({ message: `Test sent to ${group.name}`, groupId: group.id, groupName: group.name });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        if (message.includes("WhatsApp") || message.includes("selected") || message.includes("group")) {
          return res.status(400).json({ message });
        }
        logger.error("[location-whatsapp-test] Error", { error });
        res.status(500).json({ message });
      }
    }
  );
}
