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

// ─── API token masking ────────────────────────────────────────────────────────

const API_TOKEN_MASK = "••••••";

/**
 * The only form of a stored Green API token that may leave the server: a mask
 * plus, for a token long enough not to give itself away, its last 4 characters.
 */
export function maskGreenApiToken(token: string | null | undefined): string {
  const clean = String(token ?? "").trim();
  if (!clean) return "";
  return clean.length > 8 ? `${API_TOKEN_MASK}${clean.slice(-4)}` : API_TOKEN_MASK;
}

/**
 * The token a settings PUT should store, or "" to keep the stored one: an
 * omitted, blank, non-string or masked value (one echoed back from a GET,
 * which always starts with "•") never overwrites the real token.
 */
export function submittedGreenApiToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.startsWith("•") ? "" : trimmed;
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
