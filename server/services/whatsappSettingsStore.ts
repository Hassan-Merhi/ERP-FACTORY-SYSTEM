// Extracted from ./whatsappService.ts
import { pool } from "../db";
import { cleanGreenApiCredential } from "./whatsappGroupSettings";

export interface WaSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  monthlyAutoSend: boolean;
  dailyAutoSend: boolean;
  dailyRecipientId: number | null;
}

export interface WaRecipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

/** Normalise a plain phone number to chatId format (243XXXXXXXX → 243XXXXXXXX@c.us) */
export function normaliseChatId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed; // already formatted (group or individual)
  const digits = trimmed.replace(/\D/g, "");
  return `${digits}@c.us`;
}

// ─── DB reads ─────────────────────────────────────────────────────────────────

export async function getWaSettings(): Promise<WaSettings | null> {
  return getWaSettingsById(1);
}

export async function getWaSettingsById(id: number): Promise<WaSettings | null> {
  const res = await pool.query(
    "SELECT instance_id, api_token, enabled, monthly_auto_send, daily_auto_send, daily_recipient_id FROM whatsapp_settings WHERE id = $1",
    [id]
  );
  if (!res.rows?.length) return null;
  const r = res.rows[0];
  return {
    instanceId: cleanGreenApiCredential(r.instance_id),
    apiToken: cleanGreenApiCredential(r.api_token),
    enabled: r.enabled ?? false,
    monthlyAutoSend: r.monthly_auto_send ?? false,
    dailyAutoSend: r.daily_auto_send ?? false,
    dailyRecipientId: r.daily_recipient_id ?? null,
  };
}

export async function getActiveRecipients(): Promise<WaRecipient[]> {
  const res = await pool.query(
    "SELECT id, chat_id, name, is_group, active FROM whatsapp_recipients WHERE active = true ORDER BY id"
  );
  return (res.rows || []).map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    isGroup: r.is_group,
    active: r.active,
  }));
}
