/**
 * Phase 2: settings, eligible order selection and explicit consolidated
 * Stock Transfer Order approval request. No DONE processing or stock mutation.
 */
import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../auth";
import { pool, db } from "../db";
import { logger } from "../lib/logger";
import { webhookTokenIsConfigured } from "../services/security/stockTransferOrderWaWebhookAuthentication";
import { stockTransferOrderWaExecutionEnabled } from "../services/stockTransferOrderWhatsAppApprovalWorker";
import { stockTransferOrderWaDeliveryEnabled, queueStockTransferOrderWaDeliveries } from "../services/stockTransferOrderWaDeliveryWorker";
import { reconcileStockTransferOrderWaDelivery, StockTransferOrderDeliveryReconciliationError } from "../services/stockTransferOrderWaDeliveryReconciliation";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext } from "../services/security/databaseScopeRuntimeContext";
import {
  createStockTransferOrderApprovalDraft,
  assertStockTransferOrderApprovalBatchCurrent,
  StockTransferOrderApprovalError,
} from "../services/stockTransferOrderWhatsAppApprovalBatch";
import {
  getWaSettings, getStrictGreenMainInstanceState, getStrictGreenMainWebhookReadiness, fetchStrictGreenMainChats,
  sendStockTransferOrderApprovalRequest,
} from "../services/whatsappService";

const groupPattern = /^[0-9]{5,25}@g[.]us$/;
const recipientPattern = /^[0-9]{5,25}@(g[.]us|c[.]us)$/;
const phonePattern = /^\+[1-9][0-9]{6,14}$/;
const admins = requireRole("Admin", "Owner", "Developer");
const senders = requireRole("Admin", "Owner", "Developer", "Manager");

async function actor(req: Request) {
  const a = await getActiveCompanyPermissionContext(req);
  if (!Number.isSafeInteger(a.companyId) || a.companyId <= 0) throw new Error("Active company required");
  const onlyAdmins = req.method === "PUT" || /\/(?:legacy|enroll-legacy|cancel|reconcile|deliveries)$/.test(req.path);
  const roles = onlyAdmins ? ["Admin", "Owner", "Developer"] : ["Admin", "Owner", "Developer", "Manager"];
  if (!roles.includes(a.role)) {
    const error = Object.assign(new Error("Active company does not permit this approval action"), { status: 403 });
    throw error;
  }
  return a;
}
function idOf(v: unknown) {
  const id = Number(v);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function clean(v: unknown) {
  // Replace ASCII control characters (U+0000–U+001F, U+007F) with spaces.
  const text = Array.from(String(v ?? ""), (ch) => {
    const code = ch.charCodeAt(0);
    return ch.length === 1 && (code <= 0x1f || code === 0x7f) ? " " : ch;
  }).join("");
  return text.trim().slice(0, 100);
}
function errorResponse(res: Response, e: unknown) {
  const status = Number((e as { status?: number })?.status ?? 0);
  if (status === 401 || status === 403) {
    return res.status(status).json({ message: "Active company permission is no longer valid." });
  }
  if (e instanceof StockTransferOrderDeliveryReconciliationError) {
    return res.status(e.status).json({message:e.message});
  }
  if (e instanceof StockTransferOrderApprovalError) {
    return res.status(e.code === "STO_WA_SCOPE" ? 403 : 409).json({ code: e.code, message: e.message });
  }
  if ((e as { code?: string })?.code === "23505") {
    return res.status(409).json({ message: "An order already belongs to an active approval batch." });
  }
  logger.error("[STO WA] Phase 2 failed", { error: e });
  return res.status(500).json({ message: "Stock Transfer Order WhatsApp operation failed." });
}

/**
 * Drizzle wraps PostgreSQL driver errors and logs the SQL text. For production
 * debugging return ONLY driver metadata (SQLSTATE, table and constraint), not
 * SQL text, parameters, group IDs, tokens or the WhatsApp message.
 */
function stockTransferApprovalSqlFailure(error: unknown): {
  sqlState: string | null; table: string | null; constraint: string | null;
  dataType: string | null; column: string | null; routine: string | null;
  position: number | null; step: string | null;
} {
  const step = error && typeof error === "object" &&
    typeof (error as { stoApprovalStep?: unknown }).stoApprovalStep === "string"
      ? String((error as { stoApprovalStep: string }).stoApprovalStep).slice(0, 80) : null;
  let next: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!next || typeof next !== "object") break;
    const item = next as {
      code?: unknown; table?: unknown; constraint?: unknown; cause?: unknown;
      dataType?: unknown; column?: unknown; routine?: unknown; position?: unknown;
    };
    if (typeof item.code === "string" && /^[A-Z0-9]{5}$/.test(item.code)) {
      return {
        sqlState: item.code,
        table: typeof item.table === "string" ? item.table.slice(0, 100) : null,
        constraint: typeof item.constraint === "string" ? item.constraint.slice(0, 100) : null,
        dataType: typeof item.dataType === "string" ? item.dataType.slice(0, 80) : null,
        column: typeof item.column === "string" ? item.column.slice(0, 100) : null,
        routine: typeof item.routine === "string" ? item.routine.slice(0, 100) : null,
        position: Number.isSafeInteger(Number(item.position)) ? Number(item.position) : null,
        step,
      };
    }
    next = item.cause;
  }
  return { sqlState: null, table: null, constraint: null, dataType: null, column: null, routine: null, position: null, step };
}

const BATCH_STATE_CHANGED = "Approval batch changed during delivery";
async function setBatchStatus(companyId: number, batchId: number, status: "cancelled" | "requested",
  values?: { instanceId: string; messageId: string; groupId: string }) {
  // The reservation release and event must commit together with state.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = status === "requested"
      ? await client.query(
          "UPDATE stock_transfer_order_approval_batches SET status='requested',requested_at=now(),updated_at=clock_timestamp()," +
          "whatsapp_instance_id=$3,request_message_id=$4 WHERE company_id=$1 AND id=$2 AND status='draft' RETURNING id",
          [companyId, batchId, values?.instanceId, values?.messageId]
        )
      : await client.query(
          "UPDATE stock_transfer_order_approval_batches SET status='cancelled',updated_at=clock_timestamp() " +
          "WHERE company_id=$1 AND id=$2 AND status IN ('draft','requested','stale') " +
          "AND NOT EXISTS (SELECT 1 FROM stock_transfer_order_approval_events ev " +
          "WHERE ev.company_id=$1 AND ev.batch_id=$2 " +
          "AND ev.event_type IN ('done_received','decline_received')) RETURNING id",
          [companyId, batchId]
        );
    if (result.rowCount !== 1) throw new Error(BATCH_STATE_CHANGED);
    if (status === "cancelled") {
      await client.query(
        "UPDATE stock_transfer_order_approval_batch_items SET reservation_active=false " +
        "WHERE company_id=$1 AND batch_id=$2", [companyId, batchId]
      );
    }
    await client.query(
      "INSERT INTO stock_transfer_order_approval_events " +
      "(company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,approval_group_chat_id) " +
      "VALUES ($1,$2,$3,$4,$5,$6)",
      [companyId, batchId, status === "requested" ? "request_sent" : "cancelled",
       values?.instanceId || null, values?.messageId || null, values?.groupId || null]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }
}

type RevisionSummary = {
  voucher_number_snapshot: string; revision_number_snapshot: number;
  source_location_name: string | null; changed_items: number; net_delta: string;
};
async function makeMessage(companyId: number, batchId: number, key: string, destination: string) {
  const result = await pool.query<RevisionSummary>(
    "SELECT bi.voucher_number_snapshot,br.revision_number_snapshot," +
    "COALESCE(src.name,ri.source_location_name,'Unknown') AS source_location_name," +
    "COUNT(*)::int AS changed_items,SUM(ri.delta)::text AS net_delta " +
    "FROM stock_transfer_order_approval_batch_revisions br " +
    "JOIN stock_transfer_order_approval_batch_items bi ON bi.company_id=br.company_id " +
    "AND bi.batch_id=br.batch_id AND bi.transfer_id=br.transfer_id " +
    "JOIN stock_transfer_revision_items ri ON ri.revision_id=br.revision_id " +
    "LEFT JOIN locations src ON src.id=ri.source_location_id AND src.company_id=br.company_id " +
    "WHERE br.company_id=$1 AND br.batch_id=$2 " +
    "GROUP BY bi.transfer_id,bi.voucher_number_snapshot,br.revision_id," +
    "br.revision_number_snapshot,src.name,ri.source_location_name " +
    "ORDER BY bi.voucher_number_snapshot,br.revision_number_snapshot,source_location_name",
    [companyId, batchId]
  );
  if (!result.rowCount) throw new Error("Batch has no revision details.");
  const lines = [
    "*STOCK TRANSFER ORDER — APPROVAL REQUIRED*",
    "Destination: " + clean(destination),
    "Batch: " + key, "",
    "Selected orders and all pending location revisions:",
    ...result.rows.map(r =>
      "• " + clean(r.voucher_number_snapshot) + " | Rev " + Number(r.revision_number_snapshot) +
      " | " + clean(r.source_location_name) + " | " + Number(r.changed_items) +
      " changes | Net " + String(Number(r.net_delta) > 0 ? "+" : "") + String(Number(r.net_delta)) + " units"
    ),
    "", "Reply directly to THIS message: DONE approves ALL included revisions at once.",
    "DECLINE rejects the whole batch.",
    "One valid DONE approves the exact full batch; DECLINE rejects the exact full batch.",
    "Approved quantities are exported to both configured WhatsApp recipients without cost.",
    "Any newly saved revisions invalidate this request.",
  ];
  const message = lines.join("\n");
  if (message.length > 18_500) {
    throw new StockTransferOrderApprovalError("STO_WA_MESSAGE_TOO_LARGE", "Select fewer orders; message exceeds WhatsApp limits.");
  }
  return message;
}

export function registerStockTransferOrderWaApprovalRoutes(app: Express,
  deps: { ensureGroupsTable: () => Promise<void> }) {
  app.get("/api/stock-transfer-order/wa-approval/settings", requireAuth, senders, async (req, res) => {
    try {
      const a = await actor(req);
      await deps.ensureGroupsTable();
      const [s, d, g] = await Promise.all([
        pool.query('SELECT enabled,approval_group_chat_id AS "approvalGroupChatId",' +
          'authorized_phone_e164 AS "authorizedPhoneE164" FROM stock_transfer_order_approval_settings WHERE company_id=$1', [a.companyId]),
        pool.query('SELECT l.id,l.name,rec.chat_id AS "chatId",COALESCE(rec.enabled,false) AS enabled ' +
          'FROM locations l LEFT JOIN stock_transfer_order_destination_recipients rec ' +
          'ON rec.company_id=l.company_id AND rec.destination_location_id=l.id WHERE l.company_id=$1 ORDER BY l.name', [a.companyId]),
        pool.query('SELECT id,name,chat_id AS "chatId" FROM stock_transfer_export_wa_groups ' +
          'WHERE company_id=$1 ORDER BY name', [a.companyId]),
      ]);
      const wa = await getWaSettings();
      return res.json({ settings: s.rows[0] || {enabled:false,approvalGroupChatId:null,authorizedPhoneE164:null},
        destinations: d.rows, groups: g.rows, canConfigure: ["Admin","Owner","Developer"].includes(a.role), connected: Boolean(wa?.enabled && wa.instanceId && wa.apiToken), webhookConfigured: webhookTokenIsConfigured(), executionEnabled: stockTransferOrderWaExecutionEnabled(), deliveryEnabled: stockTransferOrderWaDeliveryEnabled() });
    } catch(e) { return errorResponse(res, e); }
  });

  // Admin-only, read-only provider check. The presence of an ERP webhook
  // secret does NOT mean GREEN API points to this endpoint or sends events.
  // Never expose the main credentials, provider webhook token or linked phone.
  app.get("/api/stock-transfer-order/wa-approval/webhook-readiness",
    requireAuth, admins, async(req,res)=>{
      try {
        const a = await actor(req);
        const instance = await getWaSettings();
        if(!instance?.enabled || !instance.instanceId || !instance.apiToken) {
          return res.json({ready:false,mainConfigured:false,providerChecked:false,
            message:"Main WhatsApp credentials are missing or sending is disabled."});
        }
        const settings = await pool.query<{ authorized_phone_e164: string | null }>(
          "SELECT authorized_phone_e164 FROM stock_transfer_order_approval_settings WHERE company_id=$1",
          [a.companyId]
        );
        let provider;
        try {
          provider = await getStrictGreenMainWebhookReadiness(instance.instanceId,instance.apiToken);
        } catch {
          return res.json({ready:false,mainConfigured:true,providerChecked:false,
            message:"Could not read MAIN GREEN API webhook settings. Check its instance status and API token."});
        }
        const authorized = settings.rows[0]?.authorized_phone_e164;
        const selfApproval = Boolean(authorized && provider.mainAccountChatId &&
          provider.mainAccountChatId === authorized.slice(1) + "@c.us");
        const eventTypeEnabled = selfApproval
          ? provider.outgoingPhoneWebhookEnabled
          : provider.incomingWebhookEnabled;
        const ready = webhookTokenIsConfigured() &&
          provider.webhookEndpointMatches && provider.webhookTokenMatches && eventTypeEnabled;
        return res.json({
          ready,mainConfigured:true,providerChecked:true,
          webhookUrlConfigured:provider.webhookUrlConfigured,
          endpointMatches:provider.webhookEndpointMatches,
          webhookHost:provider.webhookHost,
          tokenMatches:provider.webhookTokenMatches,
          incomingWebhookEnabled:provider.incomingWebhookEnabled,
          outgoingPhoneWebhookEnabled:provider.outgoingPhoneWebhookEnabled,
          selfApprovalAccount:selfApproval,
          expectedPath:"/api/stock-transfer-order/wa-approval/webhook",
          message:ready?"Main GREEN API webhook is configured for the authorized approval mode.":
            !provider.webhookEndpointMatches
              ? "GREEN API is not sending callbacks to this Stock Transfer Order webhook. Check its existing URL before changing it."
              : !provider.webhookTokenMatches
                ? "GREEN API callback bearer does not match the ERP webhook secret."
                : selfApproval && !provider.outgoingPhoneWebhookEnabled
                  ? "The authorized phone is the linked WhatsApp account. Enable outgoingMessageWebhook for phone/web replies."
                  : !selfApproval && !provider.incomingWebhookEnabled
                    ? "Enable GREEN API incomingWebhook to receive replies from the authorized supervisor."
                    : "Main webhook setup is incomplete.",
        });
      }catch(e){return errorResponse(res,e);}
    });

  app.put("/api/stock-transfer-order/wa-approval/settings", requireAuth, admins, async(req,res) => {
    try {
      const a=await actor(req), enabled=req.body?.enabled;
      const groupId=String(req.body?.approvalGroupChatId ?? "").trim();
      const phone=String(req.body?.authorizedPhoneE164 ?? "").trim();
      if(typeof enabled!=="boolean" || (groupId&&!groupPattern.test(groupId)) ||
        (phone&&!phonePattern.test(phone)) || (enabled&&(!groupId||!phone))) {
        return res.status(400).json({message:"Choose a saved group and international authorized phone (+countrycode)."});
      }
      await deps.ensureGroupsTable();
      if(groupId) {
        const g=await pool.query("SELECT 1 FROM stock_transfer_export_wa_groups WHERE company_id=$1 AND chat_id=$2",[a.companyId,groupId]);
        if(!g.rowCount) return res.status(400).json({message:"Choose a company-linked WhatsApp group."});
      }
      await pool.query(
        "INSERT INTO stock_transfer_order_approval_settings(company_id,enabled,approval_group_chat_id,authorized_phone_e164,updated_by)" +
        " VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id) DO UPDATE SET enabled=EXCLUDED.enabled," +
        "approval_group_chat_id=EXCLUDED.approval_group_chat_id,authorized_phone_e164=EXCLUDED.authorized_phone_e164," +
        "updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()",
        [a.companyId,enabled,groupId||null,phone||null,String(a.userId)]);
      return res.json({ok:true});
    } catch(e) {return errorResponse(res,e);}
  });

  app.put("/api/stock-transfer-order/wa-approval/destinations/:destinationId",
    requireAuth, admins, async(req,res)=>{
      try {
        const a=await actor(req), destinationId=idOf(req.params.destinationId);
        const chatId=String(req.body?.chatId??"").trim(),enabled=req.body?.enabled;
        if(!destinationId||!recipientPattern.test(chatId)||typeof enabled!=="boolean") {
          return res.status(400).json({message:"Enter a valid linked WhatsApp group or number."});
        }
        const owned=await pool.query("SELECT 1 FROM locations WHERE company_id=$1 AND id=$2",[a.companyId,destinationId]);
        if(!owned.rowCount) return res.status(404).json({message:"Destination not found for this company."});
        await pool.query(
          "INSERT INTO stock_transfer_order_destination_recipients(company_id,destination_location_id,chat_id,enabled,updated_by)" +
          " VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,destination_location_id) DO UPDATE SET " +
          "chat_id=EXCLUDED.chat_id,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()",
          [a.companyId,destinationId,chatId,enabled,String(a.userId)]);
        return res.json({ok:true});
      } catch(e) {return errorResponse(res,e);}
    });

  app.get("/api/stock-transfer-order/wa-approval/eligible",requireAuth,senders,async(req,res)=>{
    try {
      const a=await actor(req),dest=idOf(req.query.destinationId);
      if(!dest)return res.status(400).json({message:"Choose a destination."});
      const result=await pool.query(
        'SELECT t.id AS "transferId",v.voucher_number AS "voucherNumber",d.name AS "destinationName",' +
        'COUNT(r.id)::int AS "pendingRevisions", COALESCE(bool_or(bi.id IS NOT NULL),false) AS "reserved" ' +
        'FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id ' +
        'JOIN locations d ON d.id=t.destination_location_id AND d.company_id=v.company_id ' +
        "JOIN stock_transfer_revisions r ON r.transfer_id=t.id AND r.status='pending' " +
        'LEFT JOIN stock_transfer_order_approval_batch_items bi ON bi.transfer_id=t.id ' +
        'AND bi.company_id=v.company_id AND bi.reservation_active=true ' +
        "WHERE v.company_id=$1 AND t.destination_location_id=$2 AND t.workflow_origin='stock_transfer_order' " +
        "AND v.deleted_at IS NULL AND v.voucher_type='Stock Transfer' " +
        'GROUP BY t.id,v.voucher_number,d.name ORDER BY v.voucher_number DESC LIMIT 100',
        [a.companyId,dest]);
      return res.json({orders:result.rows});
    } catch(e) {return errorResponse(res,e);}
  });

  // Legacy orders predate the server-owned workflow marker. Only an Admin,
  // Owner or Developer may explicitly classify a historically labelled order.
  // No inventory, quantities, vouchers or revision statuses are updated.
  app.get("/api/stock-transfer-order/wa-approval/legacy",requireAuth,admins,async(req,res)=>{
    try {
      const a=await actor(req),dest=idOf(req.query.destinationId);
      if(!dest)return res.status(400).json({message:"Choose a destination."});
      const result=await pool.query(
        'SELECT t.id AS "transferId",v.voucher_number AS "voucherNumber",' +
        'COUNT(DISTINCT r.id)::int AS "pendingRevisions" ' +
        'FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id ' +
        "JOIN stock_transfer_revisions r ON r.transfer_id=t.id AND r.status='pending' " +
        'WHERE v.company_id=$1 AND t.destination_location_id=$2 ' +
        "AND t.workflow_origin='stock_transfer' AND v.deleted_at IS NULL " +
        "AND v.voucher_type='Stock Transfer' " +
        "AND (v.description LIKE 'Stock Transfer Order - %' OR t.notes LIKE 'Stock Transfer Order - %') " +
        'GROUP BY t.id,v.voucher_number ORDER BY v.voucher_number DESC LIMIT 100',
        [a.companyId,dest]);
      return res.json({orders:result.rows});
    } catch(e){return errorResponse(res,e);}
  });

  app.post("/api/stock-transfer-order/wa-approval/enroll-legacy",requireAuth,admins,async(req,res)=>{
    try {
      const a=await actor(req),dest=idOf(req.body?.destinationLocationId);
      const ids:unknown=req.body?.transferIds;
      if(!dest||req.body?.acknowledge!==true||!Array.isArray(ids)||ids.length<1||
         ids.length>100||new Set(ids).size!==ids.length||
         ids.some(id=>!Number.isSafeInteger(id)||id<=0)) {
        return res.status(400).json({message:"Explicitly select and confirm eligible historical Stock Transfer Orders."});
      }
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        const selected=await client.query(
          "SELECT t.id FROM stock_transfer_vouchers t JOIN vouchers v ON v.id=t.voucher_id " +
          "WHERE v.company_id=$1 AND t.destination_location_id=$2 AND t.id=ANY($3::int[]) " +
          "AND EXISTS (SELECT 1 FROM stock_transfer_revisions r WHERE r.transfer_id=t.id AND r.status='pending') " +
          "AND t.workflow_origin='stock_transfer' AND v.deleted_at IS NULL " +
          "AND v.voucher_type='Stock Transfer' " +
          "AND (v.description LIKE 'Stock Transfer Order - %' OR t.notes LIKE 'Stock Transfer Order - %') " +
          "ORDER BY t.id FOR UPDATE OF t",
          [a.companyId,dest,ids]);
        if(selected.rowCount!==ids.length) {
          await client.query("ROLLBACK");
          return res.status(409).json({message:"Some selected historical transfers cannot be confirmed as order-view documents."});
        }
        await client.query(
          "UPDATE stock_transfer_vouchers SET workflow_origin='stock_transfer_order' " +
          "WHERE id=ANY($1::int[]) AND workflow_origin='stock_transfer'",
          [ids]);
        await client.query("COMMIT");
        logger.info("[STO WA] Historical order origin explicitly enrolled",{
          companyId:a.companyId,actorId:a.userId,count:ids.length});
        return res.json({ok:true,enrolled:ids.length});
      } catch(e){await client.query("ROLLBACK");throw e;}
      finally {client.release();}
    } catch(e){return errorResponse(res,e);}
  });

  /**
   * Administrators can reconcile ONLY approved Stock Transfer Order batches,
   * scoped to the currently active ERP company. All review evidence is
   * immutable; none of these actions touch stock, vouchers or cost data.
   */
  app.get("/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries",
    requireAuth,admins,async(req,res)=>{
      try{
        const a=await actor(req),batchId=idOf(req.params.batchId);
        if(!batchId)return res.status(400).json({message:"Invalid approval batch."});
        const header=await pool.query(
          'SELECT b.id,b.batch_key AS "batchKey",b.status,' +
          'b.whatsapp_instance_id AS "whatsappInstanceId", ' +
          'b.request_message_id AS "requestMessageId", ' +
          'b.reviewed_at AS "reviewedAt",b.reviewed_by_phone_e164 AS "reviewedByPhone", ' +
          'd.name AS "destinationName" ' +
          'FROM stock_transfer_order_approval_batches b ' +
          'JOIN locations d ON d.id=b.destination_location_id AND d.company_id=b.company_id ' +
          'WHERE b.company_id=$1 AND b.id=$2',
          [a.companyId,batchId]
        );
        if(!header.rowCount)return res.status(404).json({message:"Approval batch not found."});
        const [deliveries,events,workbook]=await Promise.all([
          pool.query(
            'SELECT id,recipient_kind AS "recipientKind",recipient_chat_id AS "recipientChatId",' +
            'status,attempt_count AS "attemptCount",manual_retry_count AS "manualRetryCount",' +
            'provider_message_id AS "providerMessageId",' +
            'workbook_sha256 AS "workbookSha256",filename,' +
            'accepted_at AS "acceptedAt",updated_at AS "updatedAt",last_error AS "lastError" ' +
            'FROM stock_transfer_order_approval_deliveries ' +
            'WHERE company_id=$1 AND batch_id=$2 ORDER BY recipient_kind',
            [a.companyId,batchId]
          ),
          pool.query(
            'SELECT id,event_type AS "eventType",occurred_at AS "occurredAt",details ' +
            'FROM stock_transfer_order_approval_events ' +
            "WHERE company_id=$1 AND batch_id=$2 AND event_type IN (" +
            "'delivery_queued','delivery_accepted','delivery_failed','delivery_uncertain'," +
            "'delivery_manually_verified','delivery_manual_retry') " +
            'ORDER BY id DESC LIMIT 60',
            [a.companyId,batchId]
          ),
          pool.query(
            'SELECT snapshot_sha256 AS "snapshotSha256",workbook_sha256 AS "workbookSha256",' +
            'filename,rendered_at AS "renderedAt" ' +
            'FROM stock_transfer_order_approval_workbooks ' +
            'WHERE company_id=$1 AND batch_id=$2',
            [a.companyId,batchId]
          ),
        ]);
        return res.json({batch:header.rows[0],deliveries:deliveries.rows,
          events:events.rows,workbook:workbook.rows[0]||null,
          deliveryEnabled:stockTransferOrderWaDeliveryEnabled()});
      }catch(e){return errorResponse(res,e);}
    }
  );

  app.post("/api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile",
    requireAuth,admins,async(req,res)=>{
      try {
        const a=await actor(req),batchId=idOf(req.params.batchId);
        const recipientKind=req.params.recipientKind;
        if(!batchId||!["approval_group","destination"].includes(recipientKind)){
          return res.status(400).json({message:"Select a valid delivery and approved batch."});
        }
        const result=await reconcileStockTransferOrderWaDelivery({
          companyId:a.companyId,batchId,
          recipientKind:recipientKind as "approval_group"|"destination",
          actorId:String(a.userId),payload:req.body,
        });
        if(result.status==="pending"){
          // A fresh, explicitly authorized attempt uses the original frozen
          // destination and the same stored Excel; the durable sweep retries.
          queueStockTransferOrderWaDeliveries(batchId);
        }
        return res.json(result);
      }catch(e){return errorResponse(res,e);}
    }
  );

  app.get("/api/stock-transfer-order/wa-approval/recent",requireAuth,senders,async(req,res)=>{
    try {
      const a=await actor(req);
      const result=await pool.query(
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
        'FROM stock_transfer_order_approval_batches b ' +
        'JOIN locations d ON d.id=b.destination_location_id AND d.company_id=b.company_id ' +
        'JOIN stock_transfer_order_approval_batch_items bi ON bi.batch_id=b.id AND bi.company_id=b.company_id ' +
        'LEFT JOIN stock_transfer_order_approval_batch_revisions br ON br.company_id=b.company_id AND br.batch_id=b.id ' +
        'WHERE b.company_id=$1 GROUP BY b.id,d.name ORDER BY b.id DESC LIMIT 15',
        [a.companyId]);
      return res.json({batches:result.rows});
    } catch(e) {return errorResponse(res,e);}
  });

  app.post("/api/stock-transfer-order/wa-approval/requests",requireAuth,senders,async(req,res)=>{
    let draftId:number|null=null,accepted=false,sendUncertain=false;
    let stage = "request_validation";
    try {
      const a=await actor(req),destinationId=idOf(req.body?.destinationLocationId);
      const transferIds:unknown=req.body?.transferIds;
      if(!destinationId||!Array.isArray(transferIds)||transferIds.length<1||transferIds.length>100||
        new Set(transferIds).size!==transferIds.length||
        transferIds.some(id=>!Number.isSafeInteger(id)||id<=0)) {
        return res.status(400).json({message:"Select persisted orders from one destination."});
      }
      if(!stockTransferOrderWaExecutionEnabled()) {
        return res.status(409).json({
          message:"WhatsApp approval execution is not enabled on the authoritative ERP server."
        });
      }
      if(!stockTransferOrderWaDeliveryEnabled()) {
        return res.status(409).json({
          message:"Approved Excel WhatsApp delivery is paused; enable the main delivery worker before requesting approval."
        });
      }
      if(!webhookTokenIsConfigured()) {
        return res.status(409).json({message:"Configure the protected GREEN API approval webhook token before sending requests."});
      }
      stage="main_whatsapp_state";
      const wa=await getWaSettings();
      if(!wa?.enabled||!wa.instanceId||!wa.apiToken) {
        return res.status(409).json({
          code:"STO_WA_MAIN_NOT_CONFIGURED",
          message:"Main WhatsApp sending is disabled or its credentials are missing. " +
            "Open Settings → Export Center → Daily Export → WhatsApp Export.",
        });
      }
      // Strict: never mistake an authorized POS/backup session for the MAIN
      // account. All approval requests and quoted DONE replies use MAIN only.
      const mainState = await getStrictGreenMainInstanceState(wa.instanceId,wa.apiToken);
      if(mainState!=="authorized") {
        const guidance = mainState==="invalidCredentials"
          ? "GREEN API rejected the MAIN WhatsApp instance ID or API token (401/403). " +
            "Update MAIN credentials in Settings → Export Center → Daily Export → WhatsApp Export. " +
            "The POS connection is separate."
          : mainState==="notAuthorized"
            ? "The MAIN WhatsApp instance is disconnected. Reauthorize it in the GREEN API console."
            : mainState==="unknown"
              ? "Unable to verify the MAIN WhatsApp instance. Check its status in Export Center and retry."
              : "The MAIN WhatsApp instance is not ready (" + mainState + "). Check GREEN API.";
        return res.status(mainState==="unknown"?503:409).json({
          code:"STO_WA_MAIN_NOT_AUTHORIZED",
          state:mainState, message:guidance,
        });
      }
      stage="approval_group";
      const settings=await pool.query("SELECT approval_group_chat_id FROM stock_transfer_order_approval_settings WHERE company_id=$1 AND enabled=true",[a.companyId]);
      const group=String(settings.rows[0]?.approval_group_chat_id??"");
      if(!groupPattern.test(group))return res.status(409).json({message:"Configure the approval group first."});
      stage="approval_group_visibility";
      const chats=await fetchStrictGreenMainChats(wa.instanceId,wa.apiToken);
      if(!chats.some(c=>c.id===group&&c.id.endsWith("@g.us"))) {
        return res.status(409).json({message:"The approval group is not visible to the linked WhatsApp."});
      }
      stage="receiving_destination";
      const dest=await pool.query("SELECT name FROM locations WHERE company_id=$1 AND id=$2",[a.companyId,destinationId]);
      if(!dest.rowCount)return res.status(404).json({message:"Destination not found."});
      // Freshly pin the canonical authenticated company for this transaction.
      // The outbound GREEN API lookups may cross async network boundaries;
      // never rely on an unscoped pooled connection for frozen approval rows.
      const tenantScope = createTenantDatabaseScope(a.companyId);
      stage="freeze_order_revision_snapshot";
      const draft=await runWithDatabaseScopeRuntimeContext(tenantScope,
        () => createStockTransferOrderApprovalDraft({
          companyId:a.companyId,destinationLocationId:destinationId,transferIds:transferIds as number[],
          actorUserId:String(a.userId),
        }));
      draftId=draft.batchId;
      stage="verify_immutable_batch";
      await runWithDatabaseScopeRuntimeContext(tenantScope,
        () => db.transaction(async(tx)=>{
          await assertStockTransferOrderApprovalBatchCurrent(tx,a.companyId,draft.batchId);
        }));
      stage="format_approval_message";
      const message=await runWithDatabaseScopeRuntimeContext(tenantScope,
        () => makeMessage(a.companyId,draft.batchId,draft.batchKey,dest.rows[0].name));
      stage="send_approval_message";
      const sent=await sendStockTransferOrderApprovalRequest(draft.approvalGroupChatId,message);
      if(sent.outcome!=="accepted"||!sent.idMessage) {
        if(sent.outcome==="failed") {
          await setBatchStatus(a.companyId,draft.batchId,"cancelled");
          draftId=null;
          return res.status(502).json({message:sent.error||"WhatsApp rejected the approval request."});
        }
        // Preserve draft reservation: a timeout could mean a sent request.
        sendUncertain=true;
        await pool.query("INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details) VALUES($1,$2,'ignored',$3::jsonb)",
          [a.companyId,draft.batchId,JSON.stringify({reason:"request_send_uncertain",detail:sent.error})]);
        draftId=null;
        return res.status(202).json({ok:false,uncertain:true,batchId:draft.batchId,
          message:"Delivery outcome uncertain. Check the group; do not send this batch again."});
      }
      accepted=true;
      stage="save_provider_message_id";
      await setBatchStatus(a.companyId,draft.batchId,"requested",{
        instanceId:sent.instanceId,messageId:sent.idMessage,groupId:draft.approvalGroupChatId,
      });
      draftId=null;
      return res.json({ok:true,batchId:draft.batchId,batchKey:draft.batchKey,orders:draft.transferCount,
        revisions:draft.revisionCount,messageId:sent.idMessage,
        message:"Approval request sent. One authorized DONE will approve the entire frozen batch, then send the no-cost Excel to both recipients."});
    } catch(e) {
      const sqlFailure=stockTransferApprovalSqlFailure(e);
      logger.error(
        "[STO WA] Approval request failed before completion: " +
        "stage=" + stage + " step=" + (sqlFailure.step || "unknown") +
        " sqlState=" + (sqlFailure.sqlState || "unknown") +
        " dataType=" + (sqlFailure.dataType || "unknown") +
        " column=" + (sqlFailure.column || "unknown") +
        " table=" + (sqlFailure.table || "unknown") +
        " routine=" + (sqlFailure.routine || "unknown") +
        " position=" + (sqlFailure.position ?? "unknown") +
        " draftCreated=" + (draftId!==null) + " whatsappAccepted=" + accepted
      );
      if(draftId!==null&&!accepted&&!sendUncertain) {
        try {const a=await actor(req);await setBatchStatus(a.companyId,draftId,"cancelled");}
        catch(cleanupError){logger.error("[STO WA] Draft cleanup failed",{cleanupError,draftId});}
      }
      if(sendUncertain) {
        logger.error("[STO WA] Uncertain request could not be fully recorded", { error: e, draftId });
        return res.status(202).json({ ok: false, uncertain: true, batchId: draftId,
          message: "WhatsApp request outcome is unknown. Check the group before manually cancelling; do not resend." });
      }
      if(accepted) {
        logger.error("[STO WA] Provider accepted request but correlation could not be stored",{error:e,draftId});
        return res.status(202).json({ok:false,uncertain:true,batchId:draftId,
          message:"WhatsApp accepted the request but ERP could not save the message ID. Contact an administrator; do not resend."});
      }
      if(sqlFailure.sqlState) {
        return res.status(500).json({
          code:"STO_WA_APPROVAL_DB_FAILURE",
          message:"Could not prepare the WhatsApp approval request. No message was sent. Reference: " +
            stage + (sqlFailure.step ? "/" + sqlFailure.step : "") + " (" + sqlFailure.sqlState + ").",
        });
      }
      return errorResponse(res,e);
    }
  });

  app.post("/api/stock-transfer-order/wa-approval/requests/:batchId/cancel",requireAuth,admins,async(req,res)=>{
    try {
      const a=await actor(req),batchId=idOf(req.params.batchId);
      if(!batchId)return res.status(400).json({message:"Invalid batch."});
      await setBatchStatus(a.companyId,batchId,"cancelled");
      return res.json({ok:true});
    } catch(e) {
      // No row matched: the batch does not exist in this company, was already decided,
      // or is no longer cancellable. That is a refusal, not a server fault.
      if (e instanceof Error && e.message === BATCH_STATE_CHANGED) {
        return res.status(409).json({ message: "This approval request cannot be cancelled." });
      }
      return errorResponse(res,e);
    }
  });
}
