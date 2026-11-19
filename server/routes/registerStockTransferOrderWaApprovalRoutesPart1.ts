// Extracted from ./stockTransferOrderWaApprovalRoutes.ts to keep that module under the source-size cap.
import type { Express, Request } from "express";
import { requireAuth, requireRole } from "../auth";
import { pool } from "../db";
import { webhookTokenIsConfigured } from "../services/security/stockTransferOrderWaWebhookAuthentication";
import { getActiveCompanyPermissionContext } from "../services/security/activeCompanyPermissionContext";
import { StockTransferOrderApprovalError } from "../services/stockTransferOrderWhatsAppApprovalBatch";
import { getStrictGreenMainWebhookReadiness, getWaSettings } from "../services/whatsappService";
import {
  clean,
  errorResponse,
  BATCH_STATE_CHANGED,
  type RevisionSummary,
} from "./registerStockTransferOrderWaApprovalRoutesPart1Helpers";
export {
  groupPattern,
  recipientPattern,
  phonePattern,
  errorResponse,
  BATCH_STATE_CHANGED,
} from "./registerStockTransferOrderWaApprovalRoutesPart1Helpers";

export const admins = requireRole("Admin", "Owner", "Developer");

export const senders = requireRole("Admin", "Owner", "Developer", "Manager");

export async function actor(req: Request) {
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

export function idOf(v: unknown) {
  const id = Number(v);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Drizzle wraps PostgreSQL driver errors and logs the SQL text. For production
 * debugging return ONLY driver metadata (SQLSTATE, table and constraint), not
 * SQL text, parameters, group IDs, tokens or the WhatsApp message.
 */
export function stockTransferApprovalSqlFailure(error: unknown): {
  sqlState: string | null;
  table: string | null;
  constraint: string | null;
  dataType: string | null;
  column: string | null;
  routine: string | null;
  position: number | null;
  step: string | null;
} {
  const step =
    error && typeof error === "object" && typeof (error as { stoApprovalStep?: unknown }).stoApprovalStep === "string"
      ? String((error as { stoApprovalStep: string }).stoApprovalStep).slice(0, 80)
      : null;
  let next: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!next || typeof next !== "object") break;
    const item = next as {
      code?: unknown;
      table?: unknown;
      constraint?: unknown;
      cause?: unknown;
      dataType?: unknown;
      column?: unknown;
      routine?: unknown;
      position?: unknown;
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
  return {
    sqlState: null,
    table: null,
    constraint: null,
    dataType: null,
    column: null,
    routine: null,
    position: null,
    step,
  };
}

export async function setBatchStatus(
  companyId: number,
  batchId: number,
  status: "cancelled" | "requested",
  values?: { instanceId: string; messageId: string; groupId: string }
) {
  // The reservation release and event must commit together with state.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result =
      status === "requested"
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
          "WHERE company_id=$1 AND batch_id=$2",
        [companyId, batchId]
      );
    }
    await client.query(
      "INSERT INTO stock_transfer_order_approval_events " +
        "(company_id,batch_id,event_type,whatsapp_instance_id,provider_message_id,approval_group_chat_id) " +
        "VALUES ($1,$2,$3,$4,$5,$6)",
      [
        companyId,
        batchId,
        status === "requested" ? "request_sent" : "cancelled",
        values?.instanceId || null,
        values?.messageId || null,
        values?.groupId || null,
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function makeMessage(companyId: number, batchId: number, key: string, destination: string) {
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
    "Batch: " + key,
    "",
    "Selected orders and all pending location revisions:",
    ...result.rows.map(
      (r) =>
        "• " +
        clean(r.voucher_number_snapshot) +
        " | Rev " +
        Number(r.revision_number_snapshot) +
        " | " +
        clean(r.source_location_name) +
        " | " +
        Number(r.changed_items) +
        " changes | Net " +
        String(Number(r.net_delta) > 0 ? "+" : "") +
        String(Number(r.net_delta)) +
        " units"
    ),
    "",
    "Reply directly to THIS message: DONE approves ALL included revisions at once.",
    "DECLINE rejects the whole batch.",
    "One valid DONE approves the exact full batch; DECLINE rejects the exact full batch.",
    "Approved quantities are exported to both configured WhatsApp recipients without cost.",
    "Any newly saved revisions invalidate this request.",
  ];
  const message = lines.join("\n");
  if (message.length > 18_500) {
    throw new StockTransferOrderApprovalError(
      "STO_WA_MESSAGE_TOO_LARGE",
      "Select fewer orders; message exceeds WhatsApp limits."
    );
  }
  return message;
}

export function registerStockTransferOrderWaApprovalRoutesPart1(app: Express) {
  // Admin-only, read-only provider check. The presence of an ERP webhook
  // secret does NOT mean GREEN API points to this endpoint or sends events.
  // Never expose the main credentials, provider webhook token or linked phone.
  app.get("/api/stock-transfer-order/wa-approval/webhook-readiness", requireAuth, admins, async (req, res) => {
    try {
      const a = await actor(req);
      const instance = await getWaSettings();
      if (!instance?.enabled || !instance.instanceId || !instance.apiToken) {
        return res.json({
          ready: false,
          mainConfigured: false,
          providerChecked: false,
          message: "Main WhatsApp credentials are missing or sending is disabled.",
        });
      }
      const settings = await pool.query<{ authorized_phone_e164: string | null }>(
        "SELECT authorized_phone_e164 FROM stock_transfer_order_approval_settings WHERE company_id=$1",
        [a.companyId]
      );
      let provider;
      try {
        provider = await getStrictGreenMainWebhookReadiness(instance.instanceId, instance.apiToken);
      } catch {
        return res.json({
          ready: false,
          mainConfigured: true,
          providerChecked: false,
          message: "Could not read MAIN GREEN API webhook settings. Check its instance status and API token.",
        });
      }
      const authorized = settings.rows[0]?.authorized_phone_e164;
      const selfApproval = Boolean(
        authorized && provider.mainAccountChatId && provider.mainAccountChatId === authorized.slice(1) + "@c.us"
      );
      const eventTypeEnabled = selfApproval ? provider.outgoingPhoneWebhookEnabled : provider.incomingWebhookEnabled;
      const ready =
        webhookTokenIsConfigured() &&
        provider.webhookEndpointMatches &&
        provider.webhookTokenMatches &&
        eventTypeEnabled;
      return res.json({
        ready,
        mainConfigured: true,
        providerChecked: true,
        webhookUrlConfigured: provider.webhookUrlConfigured,
        endpointMatches: provider.webhookEndpointMatches,
        webhookHost: provider.webhookHost,
        tokenMatches: provider.webhookTokenMatches,
        incomingWebhookEnabled: provider.incomingWebhookEnabled,
        outgoingPhoneWebhookEnabled: provider.outgoingPhoneWebhookEnabled,
        selfApprovalAccount: selfApproval,
        expectedPath: "/api/stock-transfer-order/wa-approval/webhook",
        message: ready
          ? "Main GREEN API webhook is configured for the authorized approval mode."
          : !provider.webhookEndpointMatches
            ? "GREEN API is not sending callbacks to this Stock Transfer Order webhook. Check its existing URL before changing it."
            : !provider.webhookTokenMatches
              ? "GREEN API callback bearer does not match the ERP webhook secret."
              : selfApproval && !provider.outgoingPhoneWebhookEnabled
                ? "The authorized phone is the linked WhatsApp account. Enable outgoingMessageWebhook for phone/web replies."
                : !selfApproval && !provider.incomingWebhookEnabled
                  ? "Enable GREEN API incomingWebhook to receive replies from the authorized supervisor."
                  : "Main webhook setup is incomplete.",
      });
    } catch (e) {
      return errorResponse(res, e);
    }
  });
}
