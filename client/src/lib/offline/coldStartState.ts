/**
 * Plan batch 5 (decision 10): a synchronous view of the read-only cold-start
 * state, so the global fetch interceptor can refuse every write without
 * loading the offline read cache. Only offlineReadCache sets it.
 */
import { translateApplicationText } from "@/i18n/applicationTranslations";

let readOnlyUntil: number | null = null;

export function setColdStartReadOnlyUntil(until: number | null): void {
  readOnlyUntil = until;
}

/** True while this tab is a read-only cold-start viewer. */
export function coldStartReadOnlyActive(now = Date.now()): boolean {
  if (readOnlyUntil === null) return false;
  if (readOnlyUntil <= now) {
    readOnlyUntil = null;
    return false;
  }
  return true;
}

/** The local refusal every write gets during a read-only cold start. */
export const COLD_START_READ_ONLY_CODE = "OFFLINE_COLD_START_READ_ONLY";

/** HTTP 423 with the banner's own wording, in the page's language. */
export function coldStartReadOnlyResponse(): Response {
  const lang = typeof document !== "undefined" ? document.documentElement.lang.slice(0, 2) : "en";
  const language = lang === "ar" || lang === "fr" ? lang : "en";
  const message = translateApplicationText("offline.coldStart.banner", language);
  return new Response(JSON.stringify({ code: COLD_START_READ_ONLY_CODE, message }), {
    status: 423,
    headers: { "Content-Type": "application/json" },
  });
}
