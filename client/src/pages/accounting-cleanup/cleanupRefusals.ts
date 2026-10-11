/**
 * The Owner tools refuse with a code (409 *PLAN_CHANGED, 409 PERIOD_CLOSED,
 * 400 NOTHING_TO_APPLY, …). The page explains the common ones in plain words
 * (translated) and shows the server's own message for the rest.
 */
import type { ClientErrorLike } from "@/lib/clientError";

export type RefusalKind =
  "planChanged" | "periodClosed" | "nothingToApply" | "alreadyApplied" | "maintenanceRole" | "forbidden" | "other";

export interface Refusal {
  kind: RefusalKind;
  code: string | null;
  message: string;
  serverMessage: string;
}

/** Codes that mean "the tool has nothing to do here" (not a blocker to fix). */
export const NOTHING_TO_DO_CODES = new Set([
  "NOTHING_TO_APPLY",
  "NOTHING_TO_CLEAR",
  "NOTHING_TO_REPAIR",
  "NOTHING_TO_RECLASSIFY",
  "NOT_PROPERTIES_COMPANY",
  "NOT_SHOP_RENTAL_MODULE",
  "SUPPLIER_PARTNER",
]);

export const REFUSAL_TEXT: Record<RefusalKind, string> = {
  planChanged: "The data changed since the preview. Preview again, review the new figures, then apply.",
  periodClosed: "A date this tool writes is in a closed fiscal period. Reopen the period or use a later date.",
  nothingToApply: "Nothing to apply: there is nothing left for this tool to change.",
  alreadyApplied: "This tool has already been applied for this company.",
  maintenanceRole:
    "This is a maintenance action: only an Admin with the repair permission (or a Developer) can apply it.",
  forbidden: "Your role cannot run this tool. The Owner runs it.",
  other: "The server refused the request.",
};

function classify(code: string | null, status: number | undefined): RefusalKind {
  if (code) {
    if (code.endsWith("PLAN_CHANGED")) return "planChanged";
    if (/PERIOD_CLOSED|CLOSED_PERIOD/.test(code)) return "periodClosed";
    if (/^NOTHING_TO_/.test(code)) return "nothingToApply";
    if (/ALREADY_(APPLIED|ENABLED)$/.test(code)) return "alreadyApplied";
    if (code.startsWith("PRIVILEGED_MAINTENANCE_")) return "maintenanceRole";
  }
  if (status === 403) return "forbidden";
  return "other";
}

export function describeRefusal(error: unknown): Refusal {
  const failure = (error ?? {}) as ClientErrorLike & { status?: number };
  const code = typeof failure.code === "string" ? failure.code : null;
  const kind = classify(code, failure.status);
  return { kind, code, message: REFUSAL_TEXT[kind], serverMessage: failure.message ?? "" };
}
