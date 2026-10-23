/**
 * Phase 15: fail-closed gate for NEW accounting metadata writes only.
 *
 * Does NOT intercept existing ERP vouchers/POS/Factory/rent posting APIs;
 * these stay with their established permissions and posting guards.
 * Neither a metadata pilot nor its Owner approval enables real FX vouchers,
 * new reviewed fiscal posting, inventory cutover, or historical repairs.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { currentPilotEligibilityTx } from "../services/accounting/unifiedRolloutService";

/**
 * Server-side release switch for the NEW unified financial-posting endpoints
 * (reviewed fiscal close, realized-FX recognition). Kept false until a
 * separate certification; the handlers check it as well as this middleware.
 */
export const UNIFIED_FINANCIAL_POSTING_RELEASED = false;
export const UNIFIED_FINANCIAL_POSTING_LOCKED = {
  code: "ACCOUNTING_POSTING_NOT_CERTIFIED",
  message:
    "New unified accounting financial-posting endpoints remain locked until Claude certifies and the existing posting-specific Owner controls are reviewed. Metadata pilot does not unlock voucher posting.",
} as const;
function prefix(s: string, p: string) {
  return s === p || s.startsWith(p + "/");
}
/**
 * Express matches routes case-insensitively and, by default, with an optional
 * trailing slash; normalize the same way so "/close/" or "//close" cannot slip
 * past an exact-path comparison.
 */
export function normalizedAccountingPath(raw: string): string {
  const collapsed = raw.toLowerCase().replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}
function writeClass(path: string, method: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return null;
  // Preview files is POST because multipart upload is used, but it does not
  // persist a bank reconciliation or change the source voucher.
  if (path === "/api/accounting/cash-bank/preview") return null;
  if (prefix(path, "/api/accounting/monetary-fx/realized") && /\/recognize$/.test(path)) return "FINANCIAL_POSTING";
  if (path === "/api/accounting/fiscal-review/close") return "FINANCIAL_POSTING";
  if (
    prefix(path, "/api/accounting/open-items/matches") ||
    prefix(path, "/api/accounting/cash-bank/import") ||
    prefix(path, "/api/accounting/cash-bank/matches") ||
    (prefix(path, "/api/accounting/cash-bank/lines") && /\/review$/.test(path)) ||
    prefix(path, "/api/accounting/rentals/expense-links") ||
    prefix(path, "/api/accounting/fiscal-review/signoffs") ||
    path === "/api/accounting/fiscal-review/policy"
  )
    return "METADATA";
  return null;
}
export async function enforceUnifiedAccountingRollout(req: Request, res: Response, next: NextFunction) {
  const path = normalizedAccountingPath(req.originalUrl.split("?", 1)[0] || req.path);
  const type = writeClass(path, req.method.toUpperCase());
  if (!type) return next();
  // Never expose an unauthenticated policy/existence oracle. Concrete endpoint
  // role and Factory page gates also remain authoritative after this check.
  if (!req.session?.userId || !req.session?.currentCompanyId)
    return res.status(401).json({ code: "ACCOUNTING_ROLLOUT_AUTH_REQUIRED", message: "Sign in and select a company" });
  // Never fall back to an account's global role when authorizing a
  // selected-company accounting mutation.
  const role = String(req.session.currentRole ?? "");
  if (!["Admin", "Owner", "Developer"].includes(role))
    return res.status(403).json({
      code: "ACCOUNTING_ROLLOUT_ACCESS_DENIED",
      message: "Accounting metadata writes require the selected company's privileged accounting role",
    });
  if (type === "FINANCIAL_POSTING" && !UNIFIED_FINANCIAL_POSTING_RELEASED)
    return res.status(423).json(UNIFIED_FINANCIAL_POSTING_LOCKED);
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(companyId) || companyId < 1)
    return res.status(400).json({
      code: "ACCOUNTING_COMPANY_REQUIRED",
      message: "Select an authorized company",
    });
  try {
    const result = await db.transaction((tx) => currentPilotEligibilityTx(tx, companyId));
    if (!result.allowed)
      return res.status(423).json({
        code: "ACCOUNTING_READ_ONLY_ROLLOUT",
        message: result.reason,
        releaseMode: result.policy.releaseMode,
        help: "An Owner can enable a company-specific metadata pilot in Accounting → Rollout after technical, security and finance source reviews.",
      });
    return next();
  } catch {
    // A missing schema, company scope rejection or database problem must NEVER
    // unlock an uncertified accounting metadata writer.
    return res.status(503).json({
      code: "ACCOUNTING_ROLLOUT_CHECK_UNAVAILABLE",
      message: "Accounting rollout verification unavailable; new metadata writes remain locked",
    });
  }
}
