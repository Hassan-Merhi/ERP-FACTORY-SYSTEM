/**
 * Single-user POS stock-transfer revision approval with server-owned, no-cost
 * WhatsApp delivery. The delegate is selected per company by Admin/Owner/Developer;
 * this is intentionally NOT a permission granted to the POS role generally.
 */
import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { approveImmutableStockTransferRevision } from "../services/immutableStockTransferRevisionLifecycle";
import { getWaSettings, sendWhatsAppFileToChatId } from "../services/whatsappService";
import { logAudit } from "./_helpers";

type NoCostItem = { stockItemName: string; sourceLocationName: string; quantity: number };
type ExcelBuilder = (params: {
  companyName: string;
  destinationName: string;
  transferDate: string;
  items: NoCostItem[];
}) => Promise<Buffer>;

let tablePromise: Promise<void> | null = null;
async function ensureApprovalTable(ensureGroupsTable: () => Promise<void>) {
  await ensureGroupsTable();
  if (!tablePromise) {
    tablePromise = pool.query(
      'CREATE TABLE IF NOT EXISTS pos_transfer_approval_settings (' +
        'company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,' +
        'user_id varchar REFERENCES users(id) ON DELETE SET NULL,' +
        'group_id integer REFERENCES stock_transfer_export_wa_groups(id) ON DELETE SET NULL,' +
        'updated_at timestamptz NOT NULL DEFAULT now())'
    ).then(() => undefined).catch((error: unknown) => {
      tablePromise = null;
      throw error;
    });
  }
  await tablePromise;
}

async function context(req: Request) {
  return getActiveCompanyPermissionContext(req);
}

function errorResponse(res: Response, error: unknown) {
  logger.error("[PosTransferApproval] Request failed", { error });
  const status = Number((error as { status?: number })?.status ?? 0);
  if (status === 401 || status === 403) {
    return res.status(status).json({ message: "Your active company access is no longer valid." });
  }
  const code = String((error as { code?: string })?.code ?? "");
  if (code === "STOCK_TRANSFER_REVISION_SCOPE") return res.status(403).json({ message: "Transfer is outside your company." });
  if (code.startsWith("STOCK_TRANSFER_REVISION_") || code.startsWith("STOCK_TRANSFER_INSUFFICIENT_") ||
      code === "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT") {
    return res.status(409).json({ message: (error as Error).message, code });
  }
  return res.status(500).json({ message: "Stock transfer approval could not be completed." });
}

export function registerPosTransferDelegatedApprovalRoutes(
  app: Express,
  dependencies: { ensureGroupsTable: () => Promise<void>; createNoCostExcel: ExcelBuilder }
) {
  const setup = () => ensureApprovalTable(dependencies.ensureGroupsTable);

  // Settings: company-specific single POS delegate and ONE administrator-chosen group.
  app.get("/api/settings/pos-transfer-approval", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (!["Admin", "Owner", "Developer"].includes(actor.role)) return res.sendStatus(403);
      await setup();
      const [settings, users, groups] = await Promise.all([
        pool.query(
          'SELECT user_id AS "userId", group_id AS "groupId" FROM pos_transfer_approval_settings WHERE company_id=$1',
          [actor.companyId]
        ),
        pool.query(
          "SELECT DISTINCT u.id, u.username FROM users u JOIN user_company_roles ucr ON ucr.user_id=u.id " +
            "WHERE ucr.company_id=$1 AND ucr.role='POS' AND u.active=true ORDER BY u.username",
          [actor.companyId]
        ),
        pool.query(
          "SELECT id, name FROM stock_transfer_export_wa_groups WHERE company_id=$1 ORDER BY name",
          [actor.companyId]
        ),
      ]);
      return res.json({
        userId: settings.rows[0]?.userId ?? null,
        groupId: settings.rows[0]?.groupId ?? null,
        users: users.rows,
        groups: groups.rows,
      });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.put("/api/settings/pos-transfer-approval", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (!["Admin", "Owner", "Developer"].includes(actor.role)) return res.sendStatus(403);
      const userId: unknown = req.body?.userId;
      const groupId: unknown = req.body?.groupId;
      if (userId !== null && (typeof userId !== "string" || !userId.trim() || userId.length > 200)) {
        return res.status(400).json({ message: "Select one POS user, or None." });
      }
      if (groupId !== null && (!Number.isSafeInteger(groupId) || Number(groupId) <= 0)) {
        return res.status(400).json({ message: "Select a configured WhatsApp group, or None." });
      }
      await setup();
      if (userId) {
        const selected = await pool.query(
          "SELECT 1 FROM users u JOIN user_company_roles ucr ON ucr.user_id=u.id " +
            "WHERE u.id=$1 AND u.active=true AND ucr.company_id=$2 AND ucr.role='POS' LIMIT 1",
          [userId, actor.companyId]
        );
        if (!selected.rowCount) return res.status(400).json({ message: "Selected user is not an active POS user in this company." });
      }
      if (groupId) {
        const selected = await pool.query(
          "SELECT 1 FROM stock_transfer_export_wa_groups WHERE company_id=$1 AND id=$2",
          [actor.companyId, groupId]
        );
        if (!selected.rowCount) return res.status(400).json({ message: "WhatsApp group must belong to the selected company." });
      }
      await pool.query(
        "INSERT INTO pos_transfer_approval_settings (company_id,user_id,group_id,updated_at) VALUES ($1,$2,$3,now()) " +
          "ON CONFLICT(company_id) DO UPDATE SET user_id=EXCLUDED.user_id,group_id=EXCLUDED.group_id,updated_at=now()",
        [actor.companyId, userId, groupId]
      );
      logger.info("[PosTransferApproval] Delegate setting updated", {
        companyId: actor.companyId, userId: actor.userId, hasDelegate: !!userId, hasGroup: !!groupId,
      });
      return res.json({ ok: true });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // One row per transfer, never one row per revision. The lifecycle approval method
  // co-approves all pending revisions in a single transaction (latest wins per item).
  // No before/after figures, prices or rates leave this endpoint.
  app.get("/api/pos-transfer-approval/queue", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (actor.role !== "POS") return res.status(403).json({ message: "POS access only." });
      await setup();
      const settings = await pool.query(
        "SELECT user_id,group_id FROM pos_transfer_approval_settings WHERE company_id=$1",
        [actor.companyId]
      );
      if (settings.rows[0]?.user_id !== actor.userId) return res.json({ enabled: false, transfers: [] });
      if (!settings.rows[0]?.group_id) return res.json({ enabled: false, needsGroup: true, transfers: [] });
      const data = await pool.query(
        'SELECT t.id AS "transferId", MAX(r.id)::int AS "revisionId", ' +
          'COUNT(*)::int AS "pendingRevisionCount", ' +
          'v.voucher_number AS "voucherNumber", d.name AS "destinationName", ' +
          'MIN(r.revision_date) AS "createdAt" ' +
          'FROM stock_transfer_revisions r ' +
          'JOIN stock_transfer_vouchers t ON t.id=r.transfer_id ' +
          'JOIN vouchers v ON v.id=t.voucher_id ' +
          'JOIN locations d ON d.id=t.destination_location_id ' +
          "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND r.status='pending' " +
          'GROUP BY t.id, v.voucher_number, d.name ' +
          'ORDER BY MIN(r.revision_date) ASC, t.id ASC LIMIT 100',
        [actor.companyId]
      );
      return res.json({ enabled: true, transfers: data.rows });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.post("/api/pos-transfer-approval/:revisionId/approve-send", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (actor.role !== "POS") return res.sendStatus(403);
      const revisionId = Number(req.params.revisionId);
      if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
        return res.status(400).json({ message: "Invalid revision." });
      }
      await setup();
      const configured = await pool.query(
        "SELECT grp.chat_id AS \"chatId\", grp.name AS \"groupName\" " +
          "FROM pos_transfer_approval_settings s " +
          "JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id " +
          "WHERE s.company_id=$1 AND s.user_id=$2",
        [actor.companyId, actor.userId]
      );
      if (!configured.rowCount) return res.status(403).json({ message: "This user is not enabled for transfer approval and WhatsApp sending." });

      // Preflight BEFORE making any inventory movement. No arbitrary group or workbook payload from POS.
      const wa = await getWaSettings();
      if (!wa?.instanceId || !wa?.apiToken || !wa.enabled) {
        return res.status(409).json({ message: "WhatsApp is disconnected. Ask the administrator to reconnect it before approving." });
      }

      const result = await approveImmutableStockTransferRevision(
        actor.companyId,
        revisionId,
        actor.userId,
        (tx, written) => logAudit({
          userId: actor.userId,
          username: req.session.username || req.user?.username || "POS",
          companyId: actor.companyId,
          action: "approve",
          tableName: "stock_transfer_revisions",
          recordId: revisionId,
          recordIdentifier: "transfer-" + written.transferId + "-revision-" + written.revisionNumber,
          changes: {
            status: { old: written.transition === "no-op" ? "approved" : "pending", new: "approved" },
            delegatedPosApproval: { new: true },
            appliedRevisionCount: { new: written.appliedRevisionCount ?? 0 },
          },
        }, tx)
      );

      if (result.transition === "no-op") {
        return res.status(409).json({ message: "This revision was already approved. WhatsApp will not be sent twice." });
      }

      try {
        const order = await pool.query(
          'SELECT c.name AS "companyName", d.name AS "destinationName", ' +
            "to_char(v.voucher_date, 'YYYY-MM-DD') AS \"transferDate\", " +
            'i.name AS "stockItemName", COALESCE(src.name, \'Unknown\') AS "sourceLocationName", ' +
            'ti.quantity::float8 AS "quantity" ' +
            "FROM stock_transfer_vouchers t " +
            "JOIN vouchers v ON v.id=t.voucher_id " +
            "JOIN companies c ON c.id=v.company_id " +
            "JOIN locations d ON d.id=t.destination_location_id " +
            "JOIN stock_transfer_items ti ON ti.transfer_id=t.id " +
            "JOIN stock_items i ON i.id=ti.stock_item_id AND i.company_id=v.company_id " +
            "LEFT JOIN locations src ON src.id=ti.source_location_id " +
            "WHERE t.id=$1 AND v.company_id=$2 AND v.deleted_at IS NULL AND ti.quantity>0 " +
            "ORDER BY src.name,i.name",
          [result.transferId, actor.companyId]
        );

        if (!order.rowCount) {
          logger.error("[PosTransferApproval] Approved but no export rows", { revisionId, companyId: actor.companyId });
          return res.json({ approved: true, sent: false, message: "Approved, but the transfer had no valid rows to send." });
        }
        const first = order.rows[0];
        const workbook = await dependencies.createNoCostExcel({
          companyName: first.companyName,
          destinationName: first.destinationName,
          transferDate: first.transferDate,
          items: order.rows.map((item) => ({
            stockItemName: item.stockItemName,
            sourceLocationName: item.sourceLocationName,
            quantity: Number(item.quantity),
          })),
        });
        const filename = "Truck_Trip_" + String(first.destinationName).replace(/[^a-zA-Z0-9_-]/g, "_") +
          "_" + first.transferDate + "_revision_" + revisionId + ".xlsx";
        const sent = await sendWhatsAppFileToChatId(
          configured.rows[0].chatId, workbook, filename,
          "Approved stock transfer to " + first.destinationName + " (" + first.transferDate + ") — without cost",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        logger.info("[PosTransferApproval] Delegate approved transfer revision", {
          companyId: actor.companyId, userId: actor.userId, revisionId, sent: sent.success,
        });
        return res.json({
          approved: true,
          sent: sent.success,
          message: sent.success
            ? "Revision approved and cost-free transfer sent to WhatsApp."
            : "Revision approved, but WhatsApp delivery failed. Ask an administrator to resend manually.",
        });
      } catch (deliveryError) {
        logger.error("[PosTransferApproval] Revision approved, delivery failed", {
          companyId: actor.companyId, revisionId, error: deliveryError,
        });
        return res.json({ approved: true, sent: false,
          message: "Revision approved, but WhatsApp delivery failed. Ask an administrator to resend manually." });
      }
    } catch (error) {
      return errorResponse(res, error);
    }
  });
}