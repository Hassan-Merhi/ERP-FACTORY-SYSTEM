// Extracted from ./stockTransferOrderWaApprovalRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { logger } from "../lib/logger";
import {
  queueStockTransferOrderWaDeliveries,
  stockTransferOrderWaDeliveryEnabled,
} from "../services/stockTransferOrderWaDeliveryWorker";
import { reconcileStockTransferOrderWaDelivery } from "../services/stockTransferOrderWaDeliveryReconciliation";
import {
  actor,
  admins,
  errorResponse,
  idOf,
  recipientPattern,
  senders,
} from "./registerStockTransferOrderWaApprovalRoutesPart1";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";

// The handlers keep their own id, value and message checks; these declare only
// the fields client/src/pages/settings/StockTransferOrderApprovalSettings.tsx,
// StockTransferOrderApprovalRequestPanel.tsx and
// StockTransferOrderWaDeliveryReconciliation.tsx send.
const destinationInput = {
  params: z.strictObject({ destinationId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({ chatId: z.string().nullable().optional(), enabled: z.boolean().optional() }),
} satisfies RequestSchemas;

const enrollLegacyInput = {
  query: emptyQuery,
  body: z.strictObject({
    destinationLocationId: z.union([z.number(), z.string()]).nullable().optional(),
    transferIds: z.array(z.number()).optional(),
    acknowledge: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

// parseStockTransferOrderDeliveryReconciliation checks the values.
const reconcileInput = {
  params: z.strictObject({ batchId: stringParam, recipientKind: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    action: z.string().optional(),
    expectedStatus: z.string().optional(),
    reason: z.string().optional(),
    checkedWhatsApp: z.boolean().optional(),
    checkedProvider: z.boolean().optional(),
    confirmedDelivered: z.boolean().optional(),
    confirmedNotDelivered: z.boolean().optional(),
    acknowledgeDuplicateRisk: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export function registerStockTransferOrderWaApprovalRoutesPart2(app: Express) {
  app.put(
    "/api/stock-transfer-order/wa-approval/destinations/:destinationId",
    requireAuth,
    admins,
    validateRequest(destinationInput),
    async (req, res) => {
      try {
        const a = await actor(req),
          destinationId = idOf(req.params.destinationId);
        const chatId = String(req.body?.chatId ?? "").trim(),
          enabled = req.body?.enabled;
        if (!destinationId || !recipientPattern.test(chatId) || typeof enabled !== "boolean") {
          return res.status(400).json({ message: "Enter a valid linked WhatsApp group or number." });
        }
        const owned = await pool.query("SELECT 1 FROM locations WHERE company_id=$1 AND id=$2", [
          a.companyId,
          destinationId,
        ]);
        if (!owned.rowCount) return res.status(404).json({ message: "Destination not found for this company." });
        await pool.query(
          "INSERT INTO stock_transfer_order_destination_recipients(company_id,destination_location_id,chat_id,enabled,updated_by)" +
            " VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,destination_location_id) DO UPDATE SET " +
            "chat_id=EXCLUDED.chat_id,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()",
          [a.companyId, destinationId, chatId, enabled, String(a.userId)]
        );
        return res.json({ ok: true });
      } catch (e) {
        return errorResponse(res, e);
      }
    }
  );

  app.get("/api/stock-transfer-order/wa-approval/eligible", requireAuth, senders, async (req, res) => {
    try {
      const a = await actor(req),
        dest = idOf(req.query.destinationId);
      if (!dest) return res.status(400).json({ message: "Choose a destination." });
      const result = await pool.query(
        'SELECT t.id AS "transferId",v.voucher_number AS "voucherNumber",d.name AS "destinationName",' +
          'COUNT(r.id)::int AS "pendingRevisions", COALESCE(bool_or(bi.id IS NOT NULL),false) AS "reserved" ' +
          "FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id " +
          "JOIN locations d ON d.id=t.destination_location_id AND d.company_id=v.company_id " +
          "JOIN stock_transfer_revisions r ON r.transfer_id=t.id AND r.status='pending' " +
          "LEFT JOIN stock_transfer_order_approval_batch_items bi ON bi.transfer_id=t.id " +
          "AND bi.company_id=v.company_id AND bi.reservation_active=true " +
          "WHERE v.company_id=$1 AND t.destination_location_id=$2 AND t.workflow_origin='stock_transfer_order' " +
          "AND v.deleted_at IS NULL AND v.voucher_type='Stock Transfer' " +
          "GROUP BY t.id,v.voucher_number,d.name ORDER BY v.voucher_number DESC LIMIT 100",
        [a.companyId, dest]
      );
      return res.json({ orders: result.rows });
    } catch (e) {
      return errorResponse(res, e);
    }
  });

  // Legacy orders predate the server-owned workflow marker. Only an Admin,
  // Owner or Developer may explicitly classify a historically labelled order.
  // No inventory, quantities, vouchers or revision statuses are updated.
  app.get("/api/stock-transfer-order/wa-approval/legacy", requireAuth, admins, async (req, res) => {
    try {
      const a = await actor(req),
        dest = idOf(req.query.destinationId);
      if (!dest) return res.status(400).json({ message: "Choose a destination." });
      const result = await pool.query(
        'SELECT t.id AS "transferId",v.voucher_number AS "voucherNumber",' +
          'COUNT(DISTINCT r.id)::int AS "pendingRevisions" ' +
          "FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id " +
          "JOIN stock_transfer_revisions r ON r.transfer_id=t.id AND r.status='pending' " +
          "WHERE v.company_id=$1 AND t.destination_location_id=$2 " +
          "AND t.workflow_origin='stock_transfer' AND v.deleted_at IS NULL " +
          "AND v.voucher_type='Stock Transfer' " +
          "AND (v.description LIKE 'Stock Transfer Order - %' OR t.notes LIKE 'Stock Transfer Order - %') " +
          "GROUP BY t.id,v.voucher_number ORDER BY v.voucher_number DESC LIMIT 100",
        [a.companyId, dest]
      );
      return res.json({ orders: result.rows });
    } catch (e) {
      return errorResponse(res, e);
    }
  });

  app.post(
    "/api/stock-transfer-order/wa-approval/enroll-legacy",
    requireAuth,
    admins,
    validateRequest(enrollLegacyInput),
    async (req, res) => {
      try {
        const a = await actor(req),
          dest = idOf(req.body?.destinationLocationId);
        const ids: unknown = req.body?.transferIds;
        if (
          !dest ||
          req.body?.acknowledge !== true ||
          !Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 100 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
        ) {
          return res
            .status(400)
            .json({ message: "Explicitly select and confirm eligible historical Stock Transfer Orders." });
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const selected = await client.query(
            "SELECT t.id FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id " +
              "WHERE v.company_id=$1 AND t.destination_location_id=$2 AND t.id=ANY($3::int[]) " +
              "AND EXISTS (SELECT 1 FROM stock_transfer_revisions r WHERE r.transfer_id=t.id AND r.status='pending') " +
              "AND t.workflow_origin='stock_transfer' AND v.deleted_at IS NULL " +
              "AND v.voucher_type='Stock Transfer' " +
              "AND (v.description LIKE 'Stock Transfer Order - %' OR t.notes LIKE 'Stock Transfer Order - %') " +
              "ORDER BY t.id FOR UPDATE OF t",
            [a.companyId, dest, ids]
          );
          if (selected.rowCount !== ids.length) {
            await client.query("ROLLBACK");
            return res
              .status(409)
              .json({ message: "Some selected historical transfers cannot be confirmed as order-view documents." });
          }
          await client.query(
            "UPDATE stock_transfer_vouchers SET workflow_origin='stock_transfer_order' " +
              "WHERE id=ANY($1::int[]) AND workflow_origin='stock_transfer'",
            [ids]
          );
          await client.query("COMMIT");
          logger.info("[STO WA] Historical order origin explicitly enrolled", {
            companyId: a.companyId,
            actorId: a.userId,
            count: ids.length,
          });
          return res.json({ ok: true, enrolled: ids.length });
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      } catch (e) {
        return errorResponse(res, e);
      }
    }
  );

  /**
   * Administrators can reconcile ONLY approved Stock Transfer Order batches,
   * scoped to the currently active ERP company. All review evidence is
   * immutable; none of these actions touch stock, vouchers or cost data.
   */
  app.get(
    "/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries",
    requireAuth,
    admins,
    async (req, res) => {
      try {
        const a = await actor(req),
          batchId = idOf(req.params.batchId);
        if (!batchId) return res.status(400).json({ message: "Invalid approval batch." });
        const header = await pool.query(
          'SELECT b.id,b.batch_key AS "batchKey",b.status,' +
            'b.whatsapp_instance_id AS "whatsappInstanceId", ' +
            'b.request_message_id AS "requestMessageId", ' +
            'b.reviewed_at AS "reviewedAt",b.reviewed_by_phone_e164 AS "reviewedByPhone", ' +
            'd.name AS "destinationName" ' +
            "FROM stock_transfer_order_approval_batches b " +
            "JOIN locations d ON d.id=b.destination_location_id AND d.company_id=b.company_id " +
            "WHERE b.company_id=$1 AND b.id=$2",
          [a.companyId, batchId]
        );
        if (!header.rowCount) return res.status(404).json({ message: "Approval batch not found." });
        const [deliveries, events, workbook] = await Promise.all([
          pool.query(
            'SELECT id,recipient_kind AS "recipientKind",recipient_chat_id AS "recipientChatId",' +
              'status,attempt_count AS "attemptCount",manual_retry_count AS "manualRetryCount",' +
              'provider_message_id AS "providerMessageId",' +
              'workbook_sha256 AS "workbookSha256",filename,' +
              'accepted_at AS "acceptedAt",updated_at AS "updatedAt",last_error AS "lastError" ' +
              "FROM stock_transfer_order_approval_deliveries " +
              "WHERE company_id=$1 AND batch_id=$2 ORDER BY recipient_kind",
            [a.companyId, batchId]
          ),
          pool.query(
            'SELECT id,event_type AS "eventType",occurred_at AS "occurredAt",details ' +
              "FROM stock_transfer_order_approval_events " +
              "WHERE company_id=$1 AND batch_id=$2 AND event_type IN (" +
              "'delivery_queued','delivery_accepted','delivery_failed','delivery_uncertain'," +
              "'delivery_manually_verified','delivery_manual_retry') " +
              "ORDER BY id DESC LIMIT 60",
            [a.companyId, batchId]
          ),
          pool.query(
            'SELECT snapshot_sha256 AS "snapshotSha256",workbook_sha256 AS "workbookSha256",' +
              'filename,rendered_at AS "renderedAt" ' +
              "FROM stock_transfer_order_approval_workbooks " +
              "WHERE company_id=$1 AND batch_id=$2",
            [a.companyId, batchId]
          ),
        ]);
        return res.json({
          batch: header.rows[0],
          deliveries: deliveries.rows,
          events: events.rows,
          workbook: workbook.rows[0] || null,
          deliveryEnabled: stockTransferOrderWaDeliveryEnabled(),
        });
      } catch (e) {
        return errorResponse(res, e);
      }
    }
  );

  app.post(
    "/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile",
    requireAuth,
    admins,
    validateRequest(reconcileInput),
    async (req, res) => {
      try {
        const a = await actor(req),
          batchId = idOf(req.params.batchId);
        const recipientKind = req.params.recipientKind;
        if (!batchId || !["approval_group", "destination"].includes(recipientKind)) {
          return res.status(400).json({ message: "Select a valid delivery and approved batch." });
        }
        const result = await reconcileStockTransferOrderWaDelivery({
          companyId: a.companyId,
          batchId,
          recipientKind: recipientKind as "approval_group" | "destination",
          actorId: String(a.userId),
          payload: req.body,
        });
        if (result.status === "pending") {
          // A fresh, explicitly authorized attempt uses the original frozen
          // destination and the same stored Excel; the durable sweep retries.
          queueStockTransferOrderWaDeliveries(batchId);
        }
        return res.json(result);
      } catch (e) {
        return errorResponse(res, e);
      }
    }
  );

  app.get("/api/stock-transfer-order/wa-approval/recent", requireAuth, senders, async (req, res) => {
    try {
      const a = await actor(req);
      const result = await pool.query(
        'SELECT b.id,b.batch_key AS "batchKey",' +
          "CASE WHEN b.status='requested' AND EXISTS (" +
          "SELECT 1 FROM stock_transfer_order_approval_events ev " +
          "WHERE ev.company_id=b.company_id AND ev.batch_id=b.id AND ev.event_type='done_received'" +
          ") THEN 'done_received' " +
          "WHEN b.status='requested' AND EXISTS (" +
          "SELECT 1 FROM stock_transfer_order_approval_events ev " +
          "WHERE ev.company_id=b.company_id AND ev.batch_id=b.id AND ev.event_type='decline_received'" +
          ") THEN 'decline_received' " +
          "WHEN b.status='draft' AND EXISTS (" +
          "SELECT 1 FROM stock_transfer_order_approval_events ev " +
          "WHERE ev.company_id=b.company_id AND ev.batch_id=b.id " +
          "AND ev.event_type='ignored' AND ev.details->>'reason'='request_send_uncertain' " +
          ") THEN 'uncertain' ELSE b.status END AS status," +
          'b.requested_at AS "requestedAt",b.reviewed_at AS "reviewedAt",' +
          'b.reviewed_by_phone_e164 AS "reviewedByPhone",' +
          'd.name AS "destinationName",COUNT(DISTINCT bi.transfer_id)::int AS "orderCount", ' +
          'COUNT(DISTINCT br.revision_id)::int AS "revisionCount", ' +
          "(SELECT COALESCE(json_agg(json_build_object(" +
          "'recipientKind',del.recipient_kind,'status',del.status," +
          "'attemptCount',del.attempt_count,'lastError',del.last_error," +
          "'acceptedAt',del.accepted_at) ORDER BY del.recipient_kind),'[]'::json) " +
          "FROM stock_transfer_order_approval_deliveries del " +
          "WHERE del.company_id=b.company_id AND del.batch_id=b.id) AS deliveries " +
          "FROM stock_transfer_order_approval_batches b " +
          "JOIN locations d ON d.id=b.destination_location_id AND d.company_id=b.company_id " +
          "JOIN stock_transfer_order_approval_batch_items bi ON bi.batch_id=b.id AND bi.company_id=b.company_id " +
          "LEFT JOIN stock_transfer_order_approval_batch_revisions br ON br.company_id=b.company_id AND br.batch_id=b.id " +
          "WHERE b.company_id=$1 GROUP BY b.id,d.name ORDER BY b.id DESC LIMIT 15",
        [a.companyId]
      );
      return res.json({ batches: result.rows });
    } catch (e) {
      return errorResponse(res, e);
    }
  });
}
