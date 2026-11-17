// Extracted from ./posTransferDelegatedApprovalRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { fetchGreenApiChats, getGreenInstanceState, getWaSettings } from "../services/whatsappService";

type NoCostItem = { stockItemName: string; sourceLocationName: string; quantity: number };

export type ExcelBuilder = (params: {
  companyName: string;
  destinationName: string;
  transferDate: string;
  items: NoCostItem[];
}) => Promise<Buffer>;

export async function context(req: Request) {
  return getActiveCompanyPermissionContext(req);
}

export function errorResponse(res: Response, error: unknown) {
  logger.error("[PosTransferApproval] Request failed", { error });
  const status = Number((error as { status?: number })?.status ?? 0);
  if (status === 401 || status === 403) {
    return res.status(status).json({ message: "Your active company access is no longer valid." });
  }
  const code = String((error as { code?: string })?.code ?? "");
  if (code === "STOCK_TRANSFER_REVISION_SCOPE")
    return res.status(403).json({ message: "Transfer is outside your company." });
  if (
    code.startsWith("STOCK_TRANSFER_REVISION_") ||
    code.startsWith("STOCK_TRANSFER_INSUFFICIENT_") ||
    code === "STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT"
  ) {
    return res.status(409).json({ message: (error as Error).message, code });
  }
  return res.status(500).json({ message: "Stock transfer approval could not be completed." });
}

export function registerPosTransferDelegatedApprovalRoutesStep1(app: Express) {
  // Settings: company-specific single POS delegate and ONE administrator-chosen group.
  app.get("/api/settings/pos-transfer-approval", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (!["Admin", "Owner", "Developer"].includes(actor.role)) return res.sendStatus(403);
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
        pool.query("SELECT id, name FROM stock_transfer_export_wa_groups WHERE company_id=$1 ORDER BY name", [
          actor.companyId,
        ]),
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
      if (userId) {
        const selected = await pool.query(
          "SELECT 1 FROM users u JOIN user_company_roles ucr ON ucr.user_id=u.id " +
            "WHERE u.id=$1 AND u.active=true AND ucr.company_id=$2 AND ucr.role='POS' LIMIT 1",
          [userId, actor.companyId]
        );
        if (!selected.rowCount)
          return res.status(400).json({ message: "Selected user is not an active POS user in this company." });
      }
      if (groupId) {
        const selected = await pool.query(
          "SELECT 1 FROM stock_transfer_export_wa_groups WHERE company_id=$1 AND id=$2",
          [actor.companyId, groupId]
        );
        if (!selected.rowCount)
          return res.status(400).json({ message: "WhatsApp group must belong to the selected company." });
      }
      await pool.query(
        "INSERT INTO pos_transfer_approval_settings (company_id,user_id,group_id,updated_at) VALUES ($1,$2,$3,now()) " +
          "ON CONFLICT(company_id) DO UPDATE SET user_id=EXCLUDED.user_id,group_id=EXCLUDED.group_id,updated_at=now()",
        [actor.companyId, userId, groupId]
      );
      logger.info("[PosTransferApproval] Delegate setting updated", {
        companyId: actor.companyId,
        userId: actor.userId,
        hasDelegate: !!userId,
        hasGroup: !!groupId,
      });
      return res.json({ ok: true });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // Read-only delivery preflight: never approve revisions or send a message.
  // Admins can use this before assigning a POS approver or before a live order.
  app.get("/api/settings/pos-transfer-approval/delivery-health", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (!["Admin", "Owner", "Developer"].includes(actor.role)) return res.sendStatus(403);
      const saved = await pool.query(
        'SELECT s.user_id AS "userId", grp.name AS "groupName", grp.chat_id AS "chatId" ' +
          "FROM pos_transfer_approval_settings s " +
          "LEFT JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id " +
          "WHERE s.company_id=$1",
        [actor.companyId]
      );
      const settings = saved.rows[0];
      const wa = await getWaSettings();
      const credentialsConfigured = Boolean(wa?.instanceId && wa.apiToken && wa.enabled);
      const state = credentialsConfigured ? await getGreenInstanceState(wa!.instanceId, wa!.apiToken) : "notConfigured";
      let groupVisible: boolean | null = null;
      if (state === "authorized" && settings?.chatId) {
        try {
          const chats = await fetchGreenApiChats(wa!.instanceId, wa!.apiToken);
          groupVisible = chats.some((chat) => chat.id === settings.chatId);
        } catch (error) {
          logger.warn("[PosTransferApproval] Read-only WhatsApp group lookup unavailable", {
            companyId: actor.companyId,
            error,
          });
        }
      }
      return res.json({
        delegateConfigured: Boolean(settings?.userId),
        groupConfigured: Boolean(settings?.chatId),
        groupName: settings?.groupName || null,
        whatsappState: state,
        groupVisible,
        ready: Boolean(settings?.userId && settings?.chatId && state === "authorized" && groupVisible === true),
        note: "Read-only check: no inventory changes or WhatsApp sends. A visible group and authorized instance reduce delivery risk but do not guarantee receipt.",
      });
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
      const settings = await pool.query(
        "SELECT user_id,group_id FROM pos_transfer_approval_settings WHERE company_id=$1",
        [actor.companyId]
      );
      if (settings.rows[0]?.user_id !== actor.userId) return res.json({ enabled: false, destinations: [] });
      if (!settings.rows[0]?.group_id) return res.json({ enabled: false, needsGroup: true, destinations: [] });
      // One displayed approval group per receiving destination. An individual
      // destination can have several underlying stock-transfer vouchers; they
      // must still be approved as separate accounting/inventory transactions.
      const data = await pool.query(
        "WITH pending_transfers AS ( " +
          "SELECT t.id AS transfer_id, t.destination_location_id AS destination_id, " +
          "d.name AS destination_name, v.voucher_number, " +
          "MAX(r.id)::int AS revision_id, COUNT(*)::int AS revision_count, " +
          "MIN(r.revision_date) AS first_date " +
          "FROM stock_transfer_revisions r " +
          "JOIN stock_transfer_vouchers t ON t.id=r.transfer_id " +
          "JOIN vouchers v ON v.id=t.voucher_id " +
          "JOIN locations d ON d.id=t.destination_location_id " +
          "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND r.status='pending' " +
          "GROUP BY t.id,t.destination_location_id,d.name,v.voucher_number) " +
          'SELECT destination_id AS "destinationId", destination_name AS "destinationName", ' +
          'COUNT(*)::int AS "transferCount", SUM(revision_count)::int AS "pendingRevisionCount", ' +
          "json_agg(json_build_object('transferId',transfer_id,'voucherNumber',voucher_number, " +
          "'pendingRevisionCount',revision_count) ORDER BY voucher_number) AS transfers " +
          "FROM pending_transfers GROUP BY destination_id,destination_name " +
          "ORDER BY MIN(first_date) ASC,destination_id ASC LIMIT 100",
        [actor.companyId]
      );
      return res.json({ enabled: true, destinations: data.rows });
    } catch (error) {
      return errorResponse(res, error);
    }
  });
}
