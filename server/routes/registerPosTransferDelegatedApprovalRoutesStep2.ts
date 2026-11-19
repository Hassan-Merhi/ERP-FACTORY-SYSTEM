// Extracted from ./posTransferDelegatedApprovalRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { requireAuth } from "../auth";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { approveImmutableStockTransferRevision } from "../services/immutableStockTransferRevisionLifecycle";
import {
  fetchGreenApiChats,
  getGreenInstanceState,
  getWaSettings,
  sendWhatsAppFileToChatId,
} from "../services/whatsappService";
import { logAudit } from "./_helpers";
import { context, errorResponse, type ExcelBuilder } from "./registerPosTransferDelegatedApprovalRoutesStep1";

export function registerPosTransferDelegatedApprovalRoutesStep2(
  app: Express,
  dependencies: { createNoCostExcel: ExcelBuilder }
) {
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
      if (
        !Array.isArray(transferIds) ||
        transferIds.length < 1 ||
        transferIds.length > 100 ||
        new Set(transferIds).size !== transferIds.length ||
        transferIds.some((value) => !Number.isSafeInteger(value) || value <= 0)
      ) {
        return res.status(400).json({ message: "Select between 1 and 100 valid transfer vouchers." });
      }
      const configured = await pool.query(
        'SELECT grp.chat_id AS "chatId" FROM pos_transfer_approval_settings s ' +
          "JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id " +
          "WHERE s.company_id=$1 AND s.user_id=$2",
        [actor.companyId, actor.userId]
      );
      if (!configured.rowCount) {
        return res.status(403).json({ message: "You are not assigned to approve and send stock transfer orders." });
      }
      const wa = await getWaSettings();
      if (!wa?.instanceId || !wa.apiToken || !wa.enabled) {
        return res
          .status(409)
          .json({ message: "WhatsApp is disconnected. Ask the administrator to reconnect it before approving." });
      }

      const greenState = await getGreenInstanceState(wa.instanceId, wa.apiToken);
      if (greenState !== "authorized") {
        return res.status(409).json({
          message:
            "WhatsApp is not currently connected (state: " +
            greenState +
            "). No transfers were approved. Ask the administrator to reconnect it before trying again.",
        });
      }

      // Read-only destination reachability preflight. If the selected group
      // cannot be found on the connected WhatsApp account, approve nothing.
      try {
        const chats = await fetchGreenApiChats(wa.instanceId, wa.apiToken);
        if (!chats.some((chat) => chat.id === configured.rows[0].chatId)) {
          return res.status(409).json({
            message:
              "The configured WhatsApp group is not visible to the connected account. No transfers were approved. Check the group in Export Center.",
          });
        }
      } catch (error) {
        logger.warn("[PosTransferApproval] WhatsApp group preflight unavailable", {
          companyId: actor.companyId,
          destinationId,
          error,
        });
        return res.status(409).json({
          message:
            "Could not verify access to the WhatsApp group. No transfers were approved. Check the connection and try again.",
        });
      }

      const records = await pool.query(
        'SELECT t.id AS "transferId", MAX(r.id)::int AS "revisionId", ' +
          'v.voucher_number AS "voucherNumber", d.name AS "destinationName" ' +
          "FROM stock_transfer_revisions r " +
          "JOIN stock_transfer_vouchers t ON t.id=r.transfer_id " +
          "JOIN vouchers v ON v.id=t.voucher_id " +
          "JOIN locations d ON d.id=t.destination_location_id " +
          "WHERE v.company_id=$1 AND v.deleted_at IS NULL AND r.status='pending' AND t.destination_location_id=$2 " +
          "AND t.id=ANY($3::int[]) " +
          "GROUP BY t.id,v.voucher_number,d.name ORDER BY t.id ASC LIMIT 101",
        [actor.companyId, destinationId, transferIds]
      );
      if (records.rows.length !== transferIds.length) {
        return res.status(409).json({
          message:
            "One or more selected transfers are no longer pending or belong to a different destination. Refresh Orders.",
        });
      }
      if (records.rows.length > 100) {
        return res
          .status(409)
          .json({ message: "More than 100 pending transfer vouchers. Ask an administrator to review the backlog." });
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
              (auditTx, written) =>
                logAudit(
                  {
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
                  },
                  auditTx
                ),
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
          companyId: actor.companyId,
          destinationId,
          error: approvalError,
        });
        return res.status(409).json({
          message:
            "Approval could not be completed for every selected transfer. All changes were rolled back; nothing was sent to WhatsApp. Refresh Orders and review the revisions.",
        });
      }

      try {
        // Read ONLY the successfully approved transfers from persisted stock.
        // Sum duplicates sharing a source and item into one cost-free Excel row.
        const order = await pool.query(
          'SELECT c.name AS "companyName", d.name AS "destinationName", ' +
            'i.name AS "stockItemName", COALESCE(src.name, \'Unknown\') AS "sourceLocationName", ' +
            "SUM(ti.quantity)::float8 AS quantity " +
            "FROM stock_transfer_vouchers t " +
            "JOIN vouchers v ON v.id=t.voucher_id " +
            "JOIN companies c ON c.id=v.company_id " +
            "JOIN locations d ON d.id=t.destination_location_id " +
            "JOIN stock_transfer_items ti ON ti.transfer_id=t.id " +
            "JOIN stock_items i ON i.id=ti.stock_item_id AND i.company_id=v.company_id " +
            "LEFT JOIN locations src ON src.id=ti.source_location_id " +
            "WHERE v.company_id=$1 AND t.destination_location_id=$2 " +
            "AND t.id=ANY($3::int[]) AND v.deleted_at IS NULL AND ti.quantity>0 " +
            "GROUP BY c.name,d.name,i.id,i.name,src.name ORDER BY src.name,i.name",
          [actor.companyId, destinationId, approvedIds]
        );
        if (!order.rowCount) {
          return res.json({
            approved: approvedIds.length,
            total: records.rows.length,
            sent: false,
            failures: [],
            message: "Transfers approved, but no item quantities remained for a WhatsApp export.",
          });
        }
        const first = order.rows[0];
        const transferDate = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Beirut",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
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
          companyId: actor.companyId,
          userId: actor.userId,
          destinationId,
          transferCount: approvedIds.length,
          sent: outcome.success,
        });
        return res.json({
          approved: approvedIds.length,
          total: records.rows.length,
          sent: outcome.success,
          failures: [],
          message: outcome.success
            ? approvedIds.length + " transfer voucher(s) approved; Green API accepted one consolidated WhatsApp Excel."
            : outcome.deliveryOutcome === "uncertain"
              ? "Transfers approved. WhatsApp delivery status is UNKNOWN — check the group before attempting a manual resend."
              : "Transfers approved, but Green API did not accept the WhatsApp file. Ask an administrator to check and resend if needed.",
        });
      } catch (deliveryError) {
        logger.error("[PosTransferApproval] Destination approved, delivery failed", {
          companyId: actor.companyId,
          destinationId,
          error: deliveryError,
        });
        return res.json({
          approved: approvedIds.length,
          total: records.rows.length,
          sent: false,
          failures: [],
          message:
            "Transfers approved, but WhatsApp send status could not be confirmed. Check the group before any manual resend.",
        });
      }
    } catch (error) {
      return errorResponse(res, error);
    }
  });
  return {};
}
