/**
 * Standalone browser offline mode (Phase 13/15): what happens to a write when
 * the app already knows it has no connection.
 *
 * - A supported write (offlineCoverage.ts) is saved on this device in the
 *   encrypted queue, and the caller gets an `OfflineQueued` error: the global
 *   mutation handler shows "Saved offline", and forms do not treat it as a
 *   server-posted record. A second identical save within two minutes is
 *   recognised as a double click and saved once.
 * - Any other write is refused with an `OfflineUnavailable` error that says why
 *   it needs a connection. Nothing is queued for it.
 *
 * A write that was already on its way when the connection dropped is never
 * captured here: the cloud may have it, and a second copy would post twice.
 */
import { offlineError } from "./offlineError";
import { offlineAvailability, supportedOfflineWrite, type SupportedOfflineWrite } from "./offlineCoverage";
import { saveBrowserOperation, type BrowserActor } from "./browserOutbox";

export interface OfflineQueuedError extends Error {
  name: "OfflineQueued";
  description: string;
  operationId: string;
  duplicate: boolean;
}

export interface OfflineUnavailableError extends Error {
  name: "OfflineUnavailable";
  reason: string;
}

export function pathOf(url: string): string {
  try {
    return new URL(url, "http://local.invalid").pathname;
  } catch {
    return url.split("?")[0];
  }
}

export function offlineUnavailableError(method: string, url: string): OfflineUnavailableError {
  const availability = offlineAvailability(method, pathOf(url));
  // The reason is the user-facing text (offlineCoverage.ts); the panel shows it translated.
  const error = new Error(
    availability.reason ?? offlineError("OFFLINE_WRITE_NOT_AVAILABLE").message
  ) as OfflineUnavailableError;
  error.name = "OfflineUnavailable";
  error.reason = availability.reason ?? "";
  return error;
}

/** Save a supported write on this device; always throws (queued or refused). */
export async function captureOfflineWrite(
  actor: BrowserActor | null,
  method: string,
  url: string,
  data: unknown
): Promise<never> {
  const write: SupportedOfflineWrite | null = supportedOfflineWrite(method, pathOf(url));
  if (!write) throw offlineUnavailableError(method, url);
  if (!actor) throw offlineError("OFFLINE_ACTOR_NOT_PREPARED");
  const saved = await saveBrowserOperation(actor, write.kind, data);
  window.dispatchEvent(new CustomEvent("erp:browser-sync-changed"));
  const error = new Error(
    saved.duplicate ? "OFFLINE_ALREADY_SAVED_ON_DEVICE" : "OFFLINE_SAVED_ON_DEVICE"
  ) as OfflineQueuedError;
  error.name = "OfflineQueued";
  error.description = `${write.title} (${saved.record.label})`;
  error.operationId = saved.record.id;
  error.duplicate = saved.duplicate;
  throw error;
}
