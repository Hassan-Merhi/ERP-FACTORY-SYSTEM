/**
 * Manually send a cost-free Stock Transfer Order workbook to 1-2 configured
 * WhatsApp groups. Independent of automatic destination notifications.
 */
import type { Express, Request, Response } from "express";
import { excelText, createNoCostExcel, type NoCostItem } from "../services/stockTransferNoCostWorkbook";
import { requireAuth, requireRole } from "../auth";
import { pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { registerPosTransferDelegatedApprovalRoutes } from "./posTransferDelegatedApprovalRoutes";
import { registerStockTransferOrderWaApprovalRoutes } from "./stockTransferOrderWaApprovalRoutes";
import { getWaSettings, sendWhatsAppFileToChatId } from "../services/whatsappService";

const groupIdPattern = /^\d{5,25}@g\.us$/;
let tableSetup: Promise<void> | null = null;
async function ensureGroupsTable() {
  if (!tableSetup) {
    tableSetup = pool
      .query(
        `CREATE TABLE IF NOT EXISTS stock_transfer_export_wa_groups (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(company_id, chat_id)
        )`
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        tableSetup = null;
        throw error;
      });
  }
  await tableSetup;
}

function companyId(req: Request) {
  const id = req.session.currentCompanyId;
  return Number.isInteger(id) && Number(id) > 0 ? Number(id) : null;
}

function invalidGroupId(input: unknown) {
  return typeof input !== "string" || !groupIdPattern.test(input);
}

function parseItems(input: unknown): NoCostItem[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 750) return null;
  const items: NoCostItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const stockItemName = excelText(row.stockItemName);
    const sourceLocationName = excelText(row.sourceLocationName);
    const quantity = Number(row.quantity);
    if (!stockItemName || !sourceLocationName || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000)
      return null;
    // Strict allowlist: no rate, cost, amount, margin or price ever enters XLSX generation.
    items.push({ stockItemName, sourceLocationName, quantity });
  }
  return items;
}

export function registerStockTransferExportWhatsAppRoutes(app: Express) {
  const editPermission = requireRole("Admin", "Developer", "Owner");
  const sendPermission = requireRole("Admin", "Developer", "Owner", "Manager");

  // Only configured groups for the CURRENT company, not every WhatsApp chat.
  app.get(
    "/api/stock-transfer-order/whatsapp-groups",
    requireAuth,
    sendPermission,
    async (req: Request, res: Response) => {
      try {
        const id = companyId(req);
        if (!id) return res.status(400).json({ message: "Select a company" });
        await ensureGroupsTable();
        const [groups, wa] = await Promise.all([
          pool.query(
            'SELECT id, name, chat_id AS "chatId" FROM stock_transfer_export_wa_groups WHERE company_id = $1 ORDER BY name',
            [id]
          ),
          getWaSettings(),
        ]);
        res.json({ groups: groups.rows, connected: !!(wa?.instanceId && wa?.apiToken && wa.enabled) });
      } catch (error: unknown) {
        logger.error("[TransferExportWA] Groups unavailable", { error });
        res.status(500).json({ message: "WhatsApp transfer groups could not be loaded." });
      }
    }
  );

  app.post(
    "/api/stock-transfer-order/whatsapp-groups",
    requireAuth,
    editPermission,
    async (req: Request, res: Response) => {
      try {
        const id = companyId(req);
        if (!id) return res.status(400).json({ message: "Select a company" });
        const name = String(req.body?.name || "")
          .trim()
          .slice(0, 100);
        const chatId = req.body?.chatId;
        if (!name || invalidGroupId(chatId))
          return res.status(400).json({ message: "A group name and valid WhatsApp group ID are required." });
        await ensureGroupsTable();
        const count = await pool.query(
          "SELECT count(*)::int AS n FROM stock_transfer_export_wa_groups WHERE company_id=$1",
          [id]
        );
        if (count.rows[0]?.n >= 30) return res.status(400).json({ message: "Maximum 30 groups per company." });
        const inserted = await pool.query(
          'INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1,$2,$3) ON CONFLICT(company_id,chat_id) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,chat_id AS "chatId"',
          [id, name, chatId]
        );
        res.json(inserted.rows[0]);
      } catch (error: unknown) {
        logger.error("[TransferExportWA] Save group failed", { error });
        res.status(500).json({ message: "Could not save WhatsApp group." });
      }
    }
  );

  app.delete(
    "/api/stock-transfer-order/whatsapp-groups/:groupId",
    requireAuth,
    editPermission,
    async (req: Request, res: Response) => {
      try {
        const id = companyId(req);
        const groupId = Number(req.params.groupId);
        if (!id || !Number.isSafeInteger(groupId) || groupId <= 0)
          return res.status(400).json({ message: "Invalid group." });
        await ensureGroupsTable();
        await pool.query("DELETE FROM stock_transfer_export_wa_groups WHERE company_id=$1 AND id=$2", [id, groupId]);
        res.json({ ok: true });
      } catch {
        res.status(500).json({ message: "Could not remove WhatsApp group." });
      }
    }
  );

  app.post(
    "/api/stock-transfer-order/send-whatsapp",
    requireAuth,
    sendPermission,
    async (req: Request, res: Response) => {
      try {
        const id = companyId(req);
        if (!id) return res.status(400).json({ message: "Select a company." });
        const groupIds: unknown = req.body?.groupIds;
        if (
          !Array.isArray(groupIds) ||
          groupIds.length < 1 ||
          groupIds.length > 2 ||
          new Set(groupIds).size !== groupIds.length ||
          groupIds.some((v) => !Number.isSafeInteger(v) || v <= 0)
        ) {
          return res.status(400).json({ message: "Choose one or two different WhatsApp groups." });
        }
        const items = parseItems(req.body?.items);
        const transferDate = String(req.body?.transferDate || "");
        const destination = excelText(req.body?.destination, 100);
        if (
          !items ||
          !destination ||
          !/^\d{4}-\d{2}-\d{2}$/.test(transferDate) ||
          Number.isNaN(Date.parse(transferDate + "T00:00:00Z"))
        ) {
          return res.status(400).json({ message: "Invalid transfer order, date or destination." });
        }
        await ensureGroupsTable();
        const [selected, company, wa] = await Promise.all([
          pool.query(
            'SELECT id, name, chat_id AS "chatId" FROM stock_transfer_export_wa_groups WHERE company_id=$1 AND id=ANY($2::int[])',
            [id, groupIds]
          ),
          pool.query("SELECT name FROM companies WHERE id=$1", [id]),
          getWaSettings(),
        ]);
        if (selected.rows.length !== groupIds.length || !company.rows.length) {
          return res.status(400).json({ message: "One or more groups are no longer configured for this company." });
        }
        if (!wa?.instanceId || !wa.apiToken || !wa.enabled) {
          return res
            .status(400)
            .json({ message: "Connect and enable the main WhatsApp instance in Settings → Export Center." });
        }
        const workbook = await createNoCostExcel({
          companyName: company.rows[0].name,
          destinationName: destination,
          transferDate,
          items,
        });
        const fileName = "Truck_Trip_" + destination.replace(/[/\\?%*:|"<>]/g, "_") + "_" + transferDate + ".xlsx";
        const results: { groupId: number; name: string; success: boolean; error?: string }[] = [];
        // Sequential, per-recipient results. Never automatically retry uncertain sends.
        for (const groupId of groupIds as number[]) {
          const group = selected.rows.find((x: { id: number }) => x.id === groupId);
          try {
            const outcome = await sendWhatsAppFileToChatId(
              group.chatId,
              workbook,
              fileName,
              "Stock transfer to " + destination + " (" + transferDate + ") — without cost",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            results.push({
              groupId,
              name: group.name,
              success: outcome.success,
              ...(!outcome.success ? { error: outcome.error || "Send failed" } : {}),
            });
          } catch (error: unknown) {
            results.push({ groupId, name: group.name, success: false, error: getErrorMessage(error) });
          }
        }
        const sent = results.filter((x) => x.success).length;
        logger.info("[TransferExportWA] Manual transfer export", {
          companyId: id,
          userId: req.user?.id,
          sent,
          total: results.length,
        });
        res.json({ ok: sent === results.length, sent, failed: results.length - sent, results });
      } catch (error: unknown) {
        logger.error("[TransferExportWA] Send failed", { error });
        res.status(500).json({
          message: "Unable to send the transfer export. Please try again after checking WhatsApp connectivity.",
        });
      }
    }
  );
  registerPosTransferDelegatedApprovalRoutes(app, { ensureGroupsTable, createNoCostExcel });
  registerStockTransferOrderWaApprovalRoutes(app, { ensureGroupsTable });
}
