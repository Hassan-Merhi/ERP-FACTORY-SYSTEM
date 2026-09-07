/**
 * WhatsApp prompt decision utility.
 *
 * Shared by Vouchers.tsx, JournalForm.tsx, and frontend tests so that the
 * condition that drives the "Send Statement via WhatsApp?" popup is defined
 * once and tested against the real implementation.
 *
 * Backend contract (from voucherCreateRoutes / voucherJournalRoutes):
 *   { whatsapp: { prompt: boolean, accountId?: number, month?: string } }
 */

export type WhatsAppPromptState = {
  accountId: number;
  month: string;
} | null;

type WhatsAppPromptPayload = {
  whatsapp?: {
    prompt?: unknown;
    accountId?: unknown;
    month?: unknown;
  };
};

function isWhatsAppPromptPayload(value: unknown): value is WhatsAppPromptPayload {
  return value !== null && typeof value === "object";
}

/**
 * Given an API response body, returns the WhatsApp popup state that should be
 * set — or null if no popup should appear.
 *
 * The popup appears only when all three conditions are met:
 *   1. `data.whatsapp.prompt` is truthy
 *   2. `data.whatsapp.accountId` is a non-zero number
 *   3. `data.whatsapp.month` is a non-empty string
 */
export function resolveWhatsAppPrompt(data: unknown): WhatsAppPromptState {
  if (!isWhatsAppPromptPayload(data)) return null;

  const whatsapp = data.whatsapp;
  if (
    whatsapp?.prompt &&
    typeof whatsapp.accountId === "number" &&
    whatsapp.accountId !== 0 &&
    typeof whatsapp.month === "string" &&
    whatsapp.month.length > 0
  ) {
    return {
      accountId: whatsapp.accountId,
      month: whatsapp.month,
    };
  }
  return null;
}
