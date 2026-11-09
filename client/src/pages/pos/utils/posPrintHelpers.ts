import { getErrorDetails } from "@shared/errorUtils";
import { apiRequest } from "@/lib/queryClient";
import type { ExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

type SendOptions = {
  maxAttempts?: number;
  delayMs?: number;
  onAttempt?: (n: number) => void;
  /** Caller's useExistingRecordChangeAccess(): View Only and Create Only never send. */
  access?: Pick<ExistingRecordChangeAccess, "allowed" | "reason">;
};

// Server-side invoice PDF send with retry
export async function sendInvoicePdfWithRetry(
  voucherId: number,
  locationId: number,
  opts: SendOptions = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  if (opts.access && !opts.access.allowed) return { ok: false, message: opts.access.reason ?? "" };
  let lastMessage = "WhatsApp send failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onAttempt?.(attempt);
    try {
      const res = await apiRequest("POST", "/api/pos/send-invoice-pdf-backend", { voucherId, locationId });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true };
      lastMessage = body.message || `WhatsApp send failed (HTTP ${res.status})`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, message: lastMessage };
      }
    } catch (e) {
      lastMessage = getErrorDetails(e).optionalMessage || "Network error";
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs * attempt));
  }
  return { ok: false, message: lastMessage };
}

// Server-side stock PDF send with retry
export async function sendStockPdfWithRetry(
  locationId: number,
  opts: SendOptions = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 2000;
  if (opts.access && !opts.access.allowed) return { ok: false, message: opts.access.reason ?? "" };
  let lastMessage = "WhatsApp send failed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onAttempt?.(attempt);
    try {
      const res = await apiRequest("POST", "/api/pos/send-stock-pdf-backend", { locationId });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true };
      lastMessage = body.message || `WhatsApp send failed (HTTP ${res.status})`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, message: lastMessage };
      }
    } catch (e) {
      lastMessage = getErrorDetails(e).optionalMessage || "Network error";
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs * attempt));
  }
  return { ok: false, message: lastMessage };
}
