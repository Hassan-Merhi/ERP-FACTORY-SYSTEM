import type { Express } from "express";
import { db, pool } from "../../db";
import { sql } from "drizzle-orm";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { requireExportAccess } from "../../lib/permissionMiddleware";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { logAudit } from "../_helpers";
import { fetchGreenApiChats, getPosWaSettings } from "../../services/whatsappService";

const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";

/**
 * Compatibility shim for older Location/POS settings clients that still write
 * whatsappGroupChatId through PATCH /api/locations/:id.
 *
 * The main CRUD route deliberately rejects WhatsApp fields so they cannot bypass
 * the dedicated permission boundary. This route is registered first, handles
 * only legacy WhatsApp writes, applies the same group validation + company scope,
 * and mirrors the destination into the location stock-report configuration.
 */
export function registerLocationWhatsappLegacyCompatibilityRoutes(app: Express) {
  app.patch(
    "/api/locations/:locationId",
    (req, _res, next) => {
      if (req.body?.whatsappGroupChatId === undefined) {
        next("route");
        return;
      }
      next();
    },
    requireAuth,
    requireExportAccess(LOCATION_WHATSAPP_PERMISSION),
    async (req, res) => {
      try {
        const locationId = Number.parseInt(req.params.locationId, 10);
        if (!Number.isFinite(locationId)) {
          return res.status(400).json({ message: "Invalid location ID" });
        }

        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

        const requestedName =
          typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : location.name;
        const requestedChatId =
          typeof req.body.whatsappGroupChatId === "string" && req.body.whatsappGroupChatId.trim()
            ? req.body.whatsappGroupChatId.trim()
            : null;

        let group: { id: string; name: string } | null = null;
        if (requestedChatId) {
          if (!requestedChatId.endsWith("@g.us")) {
            return res.status(400).json({ message: "A WhatsApp group must be selected" });
          }
          const settings = await getPosWaSettings();
          if (!settings?.instanceId || !settings?.apiToken) {
            return res.status(400).json({ message: "WhatsApp credentials are not configured" });
          }
          const chats = await fetchGreenApiChats(settings.instanceId, settings.apiToken);
          const match = chats.find(
            (chat) => chat.id === requestedChatId && (chat.type === "group" || chat.id.endsWith("@g.us"))
          );
          if (!match) {
            return res.status(400).json({
              message: "The selected WhatsApp group is no longer available on the connected account",
            });
          }
          group = { id: match.id, name: match.name };
        }

        const currentConfig = await pool.query(
          `SELECT enabled, whatsapp_group_chat_id, whatsapp_group_name
             FROM location_whatsapp_stock_reports
            WHERE location_id = $1 AND company_id = $2`,
          [locationId, companyId]
        );
        const previous = currentConfig.rows[0];
        // Legacy group assignment is not allowed to silently opt a new location
        // into stock-report delivery. Existing enablement is preserved.
        const reportEnabled = group ? previous?.enabled === true : false;

        // Phase 21 (B): the location, its report settings and the audit row
        // commit together (the audit ran after commit and was non-fatal).
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE locations
               SET name = ${requestedName},
                   whatsapp_group_chat_id = ${group?.id ?? null}
             WHERE id = ${locationId} AND company_id = ${companyId}
          `);
          await tx.execute(sql`
            INSERT INTO location_whatsapp_stock_reports (
              location_id, company_id, whatsapp_group_chat_id, whatsapp_group_name, enabled, updated_at
            )
            VALUES (${locationId}, ${companyId}, ${group?.id ?? null}, ${group?.name ?? null}, ${reportEnabled}, now())
            ON CONFLICT (location_id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              whatsapp_group_chat_id = EXCLUDED.whatsapp_group_chat_id,
              whatsapp_group_name = EXCLUDED.whatsapp_group_name,
              enabled = EXCLUDED.enabled,
              updated_at = now()
          `);
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update_location_whatsapp_group_legacy",
              tableName: "location_whatsapp_stock_reports",
              recordId: locationId,
              recordIdentifier: requestedName,
              changes: {
                ...(requestedName !== location.name ? { name: { old: location.name, new: requestedName } } : {}),
                whatsappGroupChatId: {
                  old: previous?.whatsapp_group_chat_id ?? location.whatsappGroupChatId ?? null,
                  new: group?.id ?? null,
                },
                whatsappGroupName: {
                  old: previous?.whatsapp_group_name ?? null,
                  new: group?.name ?? null,
                },
                enabled: {
                  old: previous?.enabled === true,
                  new: reportEnabled,
                },
              },
            },
            tx
          );
        });

        const updated = await storage.getLocationById(locationId);
        if (!updated) return res.status(404).json({ message: "Location not found after update" });

        res.json({
          ...updated,
          whatsappGroupChatId: group?.id ?? null,
          whatsappGroupName: group?.name ?? null,
          whatsappStockReportsEnabled: reportEnabled,
        });
      } catch (error: unknown) {
        logger.error("[location-whatsapp-legacy] Error", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
