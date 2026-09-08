import type { Request } from "express";
import { logger } from "../lib/logger";
import { logAudit, type AuditAction } from "../routes/helpers/auditHelpers";
import { asRecord } from "@shared/typeGuards";

interface ActivityAuditMatch {
  action: AuditAction;
  tableName: string;
  recordId: number | null;
  recordIdentifier: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
}

function parseRouteId(path: string): number | null {
  const values = path.match(/\/(\d+)(?:\/|$)/g);
  if (!values?.length) return null;
  const value = Number(values[values.length - 1].replace(/\//g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Pick the whitelisted scalar fields out of a request body for the audit trail.
 *
 * The body is whatever the client sent, so it stays `unknown` and is narrowed
 * to an indexable record here; a non-object body simply contributes no fields.
 */
function compactChanges(
  body: unknown,
  extra?: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> | null {
  const safeKeys = [
    "status",
    "reason",
    "amount",
    "currency",
    "fxRate",
    "exchangeRate",
    "chargeDate",
    "date",
    "referenceNumber",
    "newReferenceNumber",
    "prefix",
    "pattern",
    "replacement",
    "affectedRows",
    "updated",
    "skipped",
    "scope",
    "mode",
  ];
  const source = asRecord(body);
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of safeKeys) {
    const value = source?.[key];
    if (value === undefined || value === null || typeof value === "object") continue;
    changes[key] = { old: null, new: typeof value === "string" ? value.slice(0, 160) : value };
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value !== undefined && value !== null) changes[key] = { old: null, new: value };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

function classifySuccessfulActivity(req: Request): ActivityAuditMatch | null {
  const method = req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  const path = req.path.toLowerCase();
  const id = parseRouteId(path);
  const body = req.body || {};

  if (path.includes("/api/factory/customer-orders/") && path.includes("whatsapp") && !path.includes("preview")) {
    return {
      action: "send_whatsapp",
      tableName: "factory_customer_orders",
      recordId: id,
      recordIdentifier: `Customer order #${id ?? "unknown"}`,
      changes: compactChanges(body, { delivery: "whatsapp" }),
    };
  }
  if (path.includes("/api/factory/customer-orders/") && path.includes("email") && !path.includes("preview")) {
    return {
      action: "send_email",
      tableName: "factory_customer_orders",
      recordId: id,
      recordIdentifier: `Customer order #${id ?? "unknown"}`,
      changes: compactChanges(body, { delivery: "email" }),
    };
  }

  if (path.includes("/api/pos/") || path.includes("/api/factory/pos/")) {
    if (path.includes("return"))
      return {
        action: "return",
        tableName: "pos_sales",
        recordId: id,
        recordIdentifier: `POS sale #${id ?? "unknown"}`,
        changes: compactChanges(body),
      };
    if (path.includes("void"))
      return {
        action: "void",
        tableName: "pos_sales",
        recordId: id,
        recordIdentifier: `POS sale #${id ?? "unknown"}`,
        changes: compactChanges(body),
      };
    if (path.includes("cancel"))
      return {
        action: "cancel",
        tableName: "pos_sales",
        recordId: id,
        recordIdentifier: `POS sale #${id ?? "unknown"}`,
        changes: compactChanges(body),
      };
    if (method === "DELETE" && path.includes("sale"))
      return {
        action: "delete",
        tableName: "pos_sales",
        recordId: id,
        recordIdentifier: `POS sale #${id ?? "unknown"}`,
        changes: compactChanges(body),
      };
    if (path.includes("payment") && (method === "PATCH" || method === "PUT" || method === "POST"))
      return {
        action: "update",
        tableName: "pos_sales",
        recordId: id,
        recordIdentifier: `POS sale payment #${id ?? "unknown"}`,
        changes: compactChanges(body),
      };
  }

  const excludedRepairRead =
    path.includes("dry-run") || path.includes("dryrun") || path.includes("preview") || path.includes("diagnostic");
  if (
    !excludedRepairRead &&
    path.includes("/api/factory/") &&
    (path.includes("recalculate") || path.includes("recalc")) &&
    (path.includes("apply") || body?.apply === true || body?.dryRun === false)
  ) {
    return {
      action: "recalculate",
      tableName: "factory_raw_stock",
      recordId: id,
      recordIdentifier: `Factory recalculation${id ? ` #${id}` : ""}`,
      changes: compactChanges(body, { mode: "apply" }),
    };
  }
  if (
    !excludedRepairRead &&
    path.includes("/api/factory/") &&
    (path.includes("repair") || path.includes("replay")) &&
    (path.includes("apply") || body?.apply === true || body?.dryRun === false)
  ) {
    const tableName = path.includes("fx")
      ? "factory_fx_repairs"
      : path.includes("landed") || path.includes("cost")
        ? "factory_landed_cost_repairs"
        : "factory_repairs";
    return {
      action: "repair",
      tableName,
      recordId: id,
      recordIdentifier: `Factory repair${id ? ` #${id}` : ""}`,
      changes: compactChanges(body, { mode: "apply" }),
    };
  }

  if (path.includes("post-offload") || path.includes("post_offload")) {
    const action = method === "DELETE" ? "delete" : method === "POST" ? "create" : "update";
    return {
      action,
      tableName: "factory_post_offload_charges",
      recordId: id,
      recordIdentifier: `Post-offload charge #${id ?? "unknown"}`,
      changes: compactChanges(body),
    };
  }
  if (
    path.includes("reverse-offload") ||
    path.includes("reverse_offload") ||
    (path.includes("offload") && path.includes("reverse"))
  ) {
    return {
      action: "reverse",
      tableName: "factory_containers",
      recordId: id,
      recordIdentifier: `Container/offload #${id ?? "unknown"}`,
      changes: compactChanges(body),
    };
  }
  if (
    path.includes("/api/factory/") &&
    (path.includes("commission") ||
      path.includes("freight") ||
      path.includes("extra-charge") ||
      path.includes("other-charge"))
  ) {
    const action = method === "DELETE" ? "delete" : method === "POST" ? "create" : "update";
    const tableName = path.includes("commission")
      ? "factory_container_commissions"
      : path.includes("freight")
        ? "factory_container_freight"
        : "factory_container_extra_charges";
    return {
      action,
      tableName,
      recordId: id,
      recordIdentifier: `Container adjustment #${id ?? "unknown"}`,
      changes: compactChanges(body),
    };
  }

  if (path.includes("/api/factory/bales") || path.includes("/api/factory/bale")) {
    if (path.includes("relabel") || path.includes("recode"))
      return {
        action: "update",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: String(body?.referenceNumber || body?.barcode || `Bale #${id ?? "unknown"}`),
        changes: compactChanges(body, { operation: "relabel" }),
      };
    if (path.includes("restore") || path.includes("re-entry") || path.includes("reentry"))
      return {
        action: "restore",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: String(body?.referenceNumber || body?.barcode || `Bale #${id ?? "unknown"}`),
        changes: compactChanges(body),
      };
    if (path.includes("merge"))
      return {
        action: "update",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: `Bale merge${id ? ` #${id}` : ""}`,
        changes: compactChanges(body, { operation: "merge" }),
      };
    if (path.includes("split"))
      return {
        action: "create",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: `Bale split${id ? ` #${id}` : ""}`,
        changes: compactChanges(body, { operation: "split" }),
      };
    if (method === "DELETE")
      return {
        action: "delete",
        tableName: "factory_bales",
        recordId: id,
        recordIdentifier: String(body?.referenceNumber || body?.barcode || `Bale #${id ?? "unknown"}`),
        changes: compactChanges(body),
      };
  }

  return null;
}

export function writeSuccessfulActivityAudit(req: Request, statusCode: number): void {
  if (statusCode < 200 || statusCode >= 400) return;
  const match = classifySuccessfulActivity(req);
  if (!match) return;
  const session = req.session;
  const userId = session?.userId || req.user?.id;
  const companyId = session?.factoryCompanyId || session?.currentCompanyId;
  if (!userId || !companyId) return;

  void logAudit({
    userId,
    username: session?.username || String(userId),
    companyId: Number(companyId),
    action: match.action,
    tableName: match.tableName,
    recordId: match.recordId,
    recordIdentifier: match.recordIdentifier,
    changes: match.changes,
  }).catch((error: unknown) => {
    logger.warn("Activity audit write failed after successful request", {
      module: "activity-audit",
      action: match.action,
      path: req.path,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
