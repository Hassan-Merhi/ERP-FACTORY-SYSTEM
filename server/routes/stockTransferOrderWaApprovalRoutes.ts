/**
 * Phase 2: settings, eligible order selection and explicit consolidated
 * Stock Transfer Order approval request. No DONE processing or stock mutation.
 */
import type { Express } from "express";
import { requireAuth } from "../auth";
import { pool, db } from "../db";
import { logger } from "../lib/logger";
import { webhookTokenIsConfigured } from "../services/security/stockTransferOrderWaWebhookAuthentication";
import { stockTransferOrderWaExecutionEnabled } from "../services/stockTransferOrderWhatsAppApprovalWorker";
import { stockTransferOrderWaDeliveryEnabled } from "../services/stockTransferOrderWaDeliveryWorker";
import { createTenantDatabaseScope, runWithDatabaseScopeRuntimeContext } from "../services/security/databaseScopeRuntimeContext";
import { createStockTransferOrderApprovalDraft, assertStockTransferOrderApprovalBatchCurrent } from "../services/stockTransferOrderWhatsAppApprovalBatch";
import { getWaSettings, getStrictGreenMainInstanceState, fetchStrictGreenMainChats, sendStockTransferOrderApprovalRequest } from "../services/whatsappService";
import { BATCH_STATE_CHANGED, actor, admins, errorResponse, groupPattern, idOf, makeMessage, phonePattern, registerStockTransferOrderWaApprovalRoutesPart1, senders, setBatchStatus, stockTransferApprovalSqlFailure } from "./registerStockTransferOrderWaApprovalRoutesPart1";
import { registerStockTransferOrderWaApprovalRoutesPart2 } from "./registerStockTransferOrderWaApprovalRoutesPart2";

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
  registerStockTransferOrderWaApprovalRoutesPart1(app);

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
  registerStockTransferOrderWaApprovalRoutesPart2(app);
  registerStockTransferOrderWaApprovalRoutesPart3(app);
}

function registerStockTransferOrderWaApprovalRoutesPart3(app: Express) {
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
