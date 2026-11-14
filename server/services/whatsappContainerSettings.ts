/** WhatsApp container, agent-duty and transfer recipient configuration. */
import { pool } from "../db";
import { cleanGreenApiCredential } from "./whatsappGreenApiCore";

export interface ContainersWaSettings {
  groupChatId: string;
  scheduleEnabled: boolean;
  scheduleHour: number;
  lastSentAt: string | null;
  instanceId: string;
  apiToken: string;
  enabled: boolean;
}

export async function getContainersWaSettings(): Promise<ContainersWaSettings | null> {
  const res = await pool.query(
    `SELECT instance_id, api_token, enabled,
            containers_wa_group_chat_id,
            containers_wa_schedule_enabled,
            containers_wa_schedule_hour,
            containers_wa_last_sent_at
     FROM whatsapp_settings WHERE id = 1`
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
    groupChatId: r.containers_wa_group_chat_id ?? "",
    scheduleEnabled: r.containers_wa_schedule_enabled ?? false,
    scheduleHour: r.containers_wa_schedule_hour ?? 8,
    lastSentAt: r.containers_wa_last_sent_at ? new Date(r.containers_wa_last_sent_at).toISOString() : null,
  };
}

export async function updateContainersWaSettings(
  groupChatId: string,
  scheduleEnabled: boolean,
  scheduleHour: number
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_settings
     SET containers_wa_group_chat_id      = $1,
         containers_wa_schedule_enabled   = $2,
         containers_wa_schedule_hour      = $3
     WHERE id = 1`,
    [groupChatId, scheduleEnabled, scheduleHour]
  );
}

export async function markContainersWaSent(): Promise<void> {
  await pool.query(`UPDATE whatsapp_settings SET containers_wa_last_sent_at = NOW() WHERE id = 1`);
}

// ─── Agent Duty WhatsApp Settings ────────────────────────────────────────────

export async function getAgentDutyWaCredentials(): Promise<{
  groups: Record<string, string>;
  instanceId: string;
  apiToken: string;
  enabled: boolean;
} | null> {
  const res = await pool.query(
    `SELECT instance_id, api_token, enabled, agent_duty_wa_groups FROM whatsapp_settings WHERE id = 1`
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    groups: r.agent_duty_wa_groups ?? {},
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
  };
}

export async function updateAgentDutyWaGroups(groups: Record<string, string>): Promise<void> {
  await pool.query(`UPDATE whatsapp_settings SET agent_duty_wa_groups = $1 WHERE id = 1`, [JSON.stringify(groups)]);
}

// ── Stock Transfer WhatsApp Settings (per-company) ──────────────────────────

export async function setCompanyTransferWaGroupChatId(companyId: number, groupChatId: string): Promise<void> {
  await pool.query(`UPDATE companies SET transfer_wa_group_chat_id = $1 WHERE id = $2`, [
    groupChatId || null,
    companyId,
  ]);
}

export async function getAllCompanyTransferWaSettings(): Promise<
  Array<{ companyId: number; companyName: string; groupChatId: string }>
> {
  const res = await pool.query(
    `SELECT id, name, COALESCE(transfer_wa_group_chat_id, '') AS group_chat_id
     FROM companies WHERE active = true ORDER BY name`
  );
  return res.rows.map((r) => ({
    companyId: r.id,
    companyName: r.name,
    groupChatId: r.group_chat_id ?? "",
  }));
}
