/**
 * Single-user POS stock-transfer revision approval with server-owned, no-cost
 * WhatsApp delivery. The delegate is selected per company by Admin/Owner/Developer;
 * this is intentionally NOT a permission granted to the POS role generally.
 */
import type { Express } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { approveImmutableStockTransferRevision } from "../services/immutableStockTransferRevisionLifecycle";
import { getWaSettings, sendWhatsAppFileToChatId } from "../services/whatsappService";
import { logAudit } from "./_helpers";
import {
  context,
  errorResponse,
  registerPosTransferDelegatedApprovalRoutesStep1,
  type ExcelBuilder,
} from "./registerPosTransferDelegatedApprovalRoutesStep1";
import { registerPosTransferDelegatedApprovalRoutesStep2 } from "./registerPosTransferDelegatedApprovalRoutesStep2";

export function registerPosTransferDelegatedApprovalRoutes(
  app: Express,
  dependencies: { ensureGroupsTable: () => Promise<void>; createNoCostExcel: ExcelBuilder }
) {
  const { setup } = registerPosTransferDelegatedApprovalRoutesStep1(app, dependencies);
  registerPosTransferDelegatedApprovalRoutesStep2({ setup }, app, dependencies);
  registerPosTransferDelegatedApprovalRoutesStep3({ setup }, app, dependencies);
}

function registerPosTransferDelegatedApprovalRoutesStep3(
  { setup }: Pick<Awaited<ReturnType<typeof registerPosTransferDelegatedApprovalRoutesStep1>>, "setup">,
  app: Express,
  dependencies: { ensureGroupsTable: () => Promise<void>; createNoCostExcel: ExcelBuilder }
) {
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
        'SELECT grp.chat_id AS "chatId", grp.name AS "groupName" ' +
          "FROM pos_transfer_approval_settings s " +
          "JOIN stock_transfer_export_wa_groups grp ON grp.id=s.group_id AND grp.company_id=s.company_id " +
          "WHERE s.company_id=$1 AND s.user_id=$2",
        [actor.companyId, actor.userId]
      );
      if (!configured.rowCount)
        return res
          .status(403)
          .json({ message: "This user is not enabled for transfer approval and WhatsApp sending." });

      // Preflight BEFORE making any inventory movement. No arbitrary group or workbook payload from POS.
      const wa = await getWaSettings();
      if (!wa?.instanceId || !wa?.apiToken || !wa.enabled) {
        return res
          .status(409)
          .json({ message: "WhatsApp is disconnected. Ask the administrator to reconnect it before approving." });
      }

      const result = await approveImmutableStockTransferRevision(
        actor.companyId,
        revisionId,
        actor.userId,
        (tx, written) =>
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
                appliedRevisionCount: { new: written.appliedRevisionCount ?? 0 },
              },
            },
            tx
          )
      );

      if (result.transition === "no-op") {
        return res
          .status(409)
          .json({ message: "This revision was already approved. WhatsApp will not be sent twice." });
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
          return res.json({
            approved: true,
            sent: false,
            message: "Approved, but the transfer had no valid rows to send.",
          });
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
        const filename =
          "Truck_Trip_" +
          String(first.destinationName).replace(/[^a-zA-Z0-9_-]/g, "_") +
          "_" +
          first.transferDate +
          "_revision_" +
          revisionId +
          ".xlsx";
        const sent = await sendWhatsAppFileToChatId(
          configured.rows[0].chatId,
          workbook,
          filename,
          "Approved stock transfer to " + first.destinationName + " (" + first.transferDate + ") — without cost",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        logger.info("[PosTransferApproval] Delegate approved transfer revision", {
          companyId: actor.companyId,
          userId: actor.userId,
          revisionId,
          sent: sent.success,
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
          companyId: actor.companyId,
          revisionId,
          error: deliveryError,
        });
        return res.json({
          approved: true,
          sent: false,
          message: "Revision approved, but WhatsApp delivery failed. Ask an administrator to resend manually.",
        });
      }
    } catch (error) {
      return errorResponse(res, error);
    }
  });
  return {};
}
