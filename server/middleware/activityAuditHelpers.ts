// Extracted from ./activityAudit.ts
import type { AuditAction } from "../services/audit";
import { asRecord } from "@shared/typeGuards";

export interface ActivityAuditMatch {
  action: AuditAction;
  tableName: string;
  recordId: number | null;
  recordIdentifier: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
}

/**
 * Pick the whitelisted scalar fields out of a request body for the audit trail.
 *
 * The body is whatever the client sent, so it stays `unknown` and is narrowed
 * to an indexable record here; a non-object body simply contributes no fields.
 */
const SAFE_ITEM_FIELDS = [
  "stockItemId",
  "stockItemName",
  "itemName",
  "code",
  "sourceLocationId",
  "sourceLocationName",
  "destinationLocationId",
  "destinationLocationName",
  "originalQuantity",
  "quantity",
  "newQuantity",
  "delta",
  "rate",
  "unitPrice",
  "totalAmount",
] as const;

export function compactStructuredItems(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const compacted = value.slice(0, 100).flatMap((raw) => {
    const item = asRecord(raw);
    if (!item) return [];
    const safe: Record<string, unknown> = {};
    for (const field of SAFE_ITEM_FIELDS) {
      const fieldValue = item[field];
      if (fieldValue === undefined || fieldValue === null || typeof fieldValue === "object") continue;
      safe[field] = typeof fieldValue === "string" ? fieldValue.slice(0, 200) : fieldValue;
    }
    return Object.keys(safe).length > 0 ? [safe] : [];
  });
  return compacted.length > 0 ? compacted : null;
}
