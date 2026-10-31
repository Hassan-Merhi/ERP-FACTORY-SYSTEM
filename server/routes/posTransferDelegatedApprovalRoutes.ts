/**
 * Single-user POS stock-transfer revision approval with server-owned, no-cost
 * WhatsApp delivery. The delegate is selected per company by Admin/Owner/Developer;
 * this is intentionally NOT a permission granted to the POS role generally.
 */
import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { pool, db } from "../db";
import { logger } from "../lib/logger";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { approveImmutableStockTransferRevision } from "../services/immutableStockTransferRevisionLifecycle";
import { getWaSettings, getGreenInstanceState, fetchGreenApiChats, sendWhatsAppFileToChatId } from "../services/whatsappService";
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

  // Read-only delivery preflight: never approve revisions or send a message.
  // Admins can use this before assigning a POS approver or before a live order.
  app.get("/api/settings/pos-transfer-approval/delivery-health", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (!["Admin", "Owner", "Developer"].includes(actor.role)) return res.sendStatus(403);
      await setup();
      const saved = await pool.query(
        'SELECT s.user_id AS "userId", grp.name AS "groupName", grp.chat_id AS "chatId" ' +
          'FROM pos_transfer_approval_settings s ' +
          'LEFT JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id ' +
          'WHERE s.company_id=$1',
        [actor.companyId]
      );
      const settings = saved.rows[0];
      const wa = await getWaSettings();
      const credentialsConfigured = Boolean(wa?.instanceId && wa.apiToken && wa.enabled);
      const state = credentialsConfigured
        ? await getGreenInstanceState(wa!.instanceId, wa!.apiToken)
        : "notConfigured";
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
      await setup();
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
        'WITH pending_transfers AS ( ' +
          'SELECT t.id AS transfer_id, t.destination_location_id AS destination_id, ' +
          'd.name AS destination_name, v.voucher_number, ' +
          'MAX(r.id)::int AS revision_id, COUNT(*)::int AS revision_count, ' +
          'MIN(r.revision_date) AS first_date ' +
          'FROM stock_transfer_revisions r ' +
          'JOIN stock_transfer_vouchers t ON t.id=r.transfer_id ' +
          'JOIN vouchers v ON v.id=t.voucher_id ' +
          'JOIN locations d ON d.id=t.destination_location_id ' +
          "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND r.status='pending' " +
          'GROUP BY t.id,t.destination_location_id,d.name,v.voucher_number) ' +
        'SELECT destination_id AS "destinationId", destination_name AS "destinationName", ' +
          'COUNT(*)::int AS "transferCount", SUM(revision_count)::int AS "pendingRevisionCount", ' +
          'json_agg(json_build_object(\'transferId\',transfer_id,\'voucherNumber\',voucher_number, ' +
          '\'pendingRevisionCount\',revision_count) ORDER BY voucher_number) AS transfers ' +
        'FROM pending_transfers GROUP BY destination_id,destination_name ' +
        'ORDER BY MIN(first_date) ASC,destination_id ASC LIMIT 100',
        [actor.companyId]
      );
      return res.json({ enabled: true, destinations: data.rows });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  // A destination represents the receiving stock-transfer order shown to POS.
  // Underlying vouchers remain independent for accounting and inventory; only
  // the outgoing no-cost WhatsApp workbook is consolidated.
  app.post("/api/pos-transfer-approval/destination/:destinationId/approve-send", requireAuth, async (req, res) => {
    try {
      const actor = await context(req);
      if (actor.role !== "POS") return res.sendStatus(403);
      const destinationId = Number(req.params.destinationId);
      if (!Number.isSafeInteger(destinationId) || destinationId <= 0) {
        return res.status(400).json({ message: "Invalid transfer destination." });
      }
      // The POS user may exclude an unrelated voucher that has the same
      // destination. Never approve transfers added to the queue after the
      // button was clicked or rely on destination equality as an order link.
      const transferIds: unknown = req.body?.transferIds;
      if (!Array.isArray(transferIds) || transferIds.length < 1 || transferIds.length > 100 ||
          new Set(transferIds).size !== transferIds.length ||
          transferIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        return res.status(400).json({ message: "Select between 1 and 100 valid transfer vouchers." });
      }
      await setup();
      const configured = await pool.query(
        'SELECT grp.chat_id AS "chatId" FROM pos_transfer_approval_settings s ' +
          'JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id ' +
          'WHERE s.company_id=$1 AND s.user_id=$2',
        [actor.companyId, actor.userId]
      );
      if (!configured.rowCount) {
        return res.status(403).json({ message: "You are not assigned to approve and send stock transfer orders." });
      }
      const wa = await getWaSettings();
      if (!wa?.instanceId || !wa.apiToken || !wa.enabled) {
        return res.status(409).json({ message: "WhatsApp is disconnected. Ask the administrator to reconnect it before approving." });
      }

      const greenState = await getGreenInstanceState(wa.instanceId, wa.apiToken);
      if (greenState !== "authorized") {
        return res.status(409).json({
          message: "WhatsApp is not currently connected (state: " + greenState + "). No transfers were approved. Ask the administrator to reconnect it before trying again.",
        });
      }

      const records = await pool.query(
        'SELECT t.id AS "transferId", MAX(r.id)::int AS "revisionId", ' +
          'v.voucher_number AS "voucherNumber", d.name AS "destinationName" ' +
        'FROM stock_transfer_revisions r ' +
        'JOIN stock_transfer_vouchers t ON t.id=r.transfer_id ' +
        'JOIN vouchers v ON v.id=t.voucher_id ' +
        'JOIN locations d ON d.id=t.destination_location_id ' +
        "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND r.status='pending' AND t.destination_location_id=$2 " +
        "AND t.id=ANY($3::int[]) " +
        'GROUP BY t.id,v.voucher_number,d.name ORDER BY t.id ASC LIMIT 101',
        [actor.companyId, destinationId, transferIds]
      );
      if (records.rows.length !== transferIds.length) {
        return res.status(409).json({
          message: "One or more selected transfers are no longer pending or belong to a different destination. Refresh Orders.",
        });
      }
      if (records.rows.length > 100) {
        return res.status(409).json({ message: "More than 100 pending transfer vouchers. Ask an administrator to review the backlog." });
      }

      let approvedIds: number[];
      try {
        approvedIds = await db.transaction(async (tx) => {
          const ids: number[] = [];
          for (const record of records.rows) {
            const revisionId = Number(record.revisionId);
            const approved = await approveImmutableStockTransferRevision(
              actor.companyId,
              revisionId,
              actor.userId,
              (auditTx, written) => logAudit({
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
                  destinationBatchApproval: { new: true },
                  appliedRevisionCount: { new: written.appliedRevisionCount ?? 0 },
                },
              }, auditTx),
              tx
            );
            if (approved.transition !== "approved") {
              throw new Error("A selected revision was already approved or changed.");
            }
            ids.push(Number(record.transferId));
          }
          return ids;
        });
      } catch (approvalError) {
        logger.warn("[PosTransferApproval] Atomic destination approval rolled back", {
          companyId: actor.companyId, destinationId, error: approvalError,
        });
        return res.status(409).json({
          message: "Approval could not be completed for every selected transfer. All changes were rolled back; nothing was sent to WhatsApp. Refresh Orders and review the revisions.",
        });
      }

      try {
        // Read ONLY the successfully approved transfers from persisted stock.
        // Sum duplicates sharing a source and item into one cost-free Excel row.
        const order = await pool.query(
          'SELECT c.name AS "companyName", d.name AS "destinationName", ' +
            'i.name AS "stockItemName", COALESCE(src.name, \'Unknown\') AS "sourceLocationName", ' +
            'SUM(ti.quantity)::float8 AS quantity ' +
          'FROM stock_transfer_vouchers t ' +
          'JOIN vouchers v ON v.id=t.voucher_id ' +
          'JOIN companies c ON c.id=v.company_id ' +
          'JOIN locations d ON d.id=t.destination_location_id ' +
          'JOIN stock_transfer_items ti ON ti.transfer_id=t.id ' +
          'JOIN stock_items i ON i.id=ti.stock_item_id AND i.company_id=v.company_id ' +
          'LEFT JOIN locations src ON src.id=ti.source_location_id ' +
          'WHERE v.company_id=$1 AND t.destination_location_id=$2 ' +
            'AND t.id=ANY($3::int[]) AND v.deleted_at IS NULL AND ti.quantity>0 ' +
          'GROUP BY c.name,d.name,i.id,i.name,src.name ORDER BY src.name,i.name',
          [actor.companyId, destinationId, approvedIds]
        );
        if (!order.rowCount) {
          return res.json({
            approved: approvedIds.length,
            total: records.rows.length,
            sent: false,
            message: "Transfers approved, but no item quantities remained for a WhatsApp export.",
          });
        }
        const first = order.rows[0];
        const transferDate = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit"
        }).format(new Date());
        const workbook = await dependencies.createNoCostExcel({
          companyName: String(first.companyName),
          destinationName: String(first.destinationName),
          transferDate,
          items: order.rows.map((item) => ({
            stockItemName: String(item.stockItemName),
            sourceLocationName: String(item.sourceLocationName),
            quantity: Number(item.quantity),
          })),
        });
        const safeDestination = String(first.destinationName).replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = "Truck_Trip_" + safeDestination + "_" + transferDate + "_approved.xlsx";
        // One send for the destination, not one send per underlying voucher.
        const outcome = await sendWhatsAppFileToChatId(
          configured.rows[0].chatId,
          workbook,
          filename,
          "Approved stock transfer to " + first.destinationName + " (" + transferDate + ") — without cost",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        logger.info("[PosTransferApproval] Consolidated destination approval", {
          companyId: actor.companyId, userId: actor.userId, destinationId,
          transferCount: approvedIds.length, sent: outcome.success,
        });
        return res.json({
          approved: approvedIds.length,
          total: records.rows.length,
          sent: outcome.success,
          message: outcome.success
            ? approvedIds.length + " transfer voucher(s) approved; Green API accepted one consolidated WhatsApp Excel."
            : outcome.deliveryOutcome === "uncertain"
              ? "Transfers approved. WhatsApp delivery status is UNKNOWN — check the group before attempting a manual resend."
              : "Transfers approved, but Green API did not accept the WhatsApp file. Ask an administrator to check and resend if needed.",
        });
      } catch (deliveryError) {
        logger.error("[PosTransferApproval] Destination approved, delivery failed", {
          companyId: actor.companyId, destinationId, error: deliveryError,
        });
        return res.json({
          approved: approvedIds.length,
          total: records.rows.length,
          sent: false,
          message: "Transfers approved, but WhatsApp send status could not be confirmed. Check the group before any manual resend.",
        });
      }
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