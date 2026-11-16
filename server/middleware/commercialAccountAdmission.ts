import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";

type AccountRow = {
  id: string;
  status: string;
  plan: string | null;
  subscription_status: string | null;
  member_role: string;
};

type Lookup = (userId: string, companyId: number) => Promise<AccountRow[]>;

/**
 * Commercial mode is OFF unless explicitly enabled in a disposable,
 * independently isolated SaaS deployment. This does not modify legacy
 * company permissions and must be installed ahead of all ERP API routes.
 */
export const commercialModeEnabled = () => process.env.DAKZO_COMMERCIAL_MODE === "enabled";

const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/boot",
  "/api/csrf-token",
  "/api/build-info",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
]);
const UNSUPPORTED_PATHS = [
  /^\/api\/global\//,
  /^\/api\/git(?:\/|$)/,
  /^\/api\/debug(?:\/|$)/,
  /^\/api\/remote-/,
  /^\/api\/admin(?:\/|$)/,
  /^\/api\/company-/,
  /^\/api\/user-company-roles/,
];
const SECONDARY_IDS = new Set([
  "companyId",
  "sourceCompanyId",
  "destinationCompanyId",
  "srcCompanyId",
  "destCompanyId",
  "targetCompanyId",
  "fromCompanyId",
  "toCompanyId",
  "sellerCompanyId",
  "buyerCompanyId",
]);

function scanCompanyIdentifiers(node: unknown, depth = 0, count = { n: 0 }): number[] | null {
  if (depth > 12 || count.n++ > 1200) return null;
  if (node === null || typeof node !== "object") return [];
  const result: number[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SECONDARY_IDS.has(key)) {
      // Repeated/ambiguous company ID input is rejected, not silently coerced.
      if (typeof value !== "string" && typeof value !== "number") return null;
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      result.push(id);
    } else if (value && typeof value === "object") {
      const nested = scanCompanyIdentifiers(value, depth + 1, count);
      if (!nested) return null;
      result.push(...nested);
    }
  }
  return result;
}

export function decideCommercialAccountAdmission(params: {
  account: AccountRow | null;
  requestedCompanies: number[] | null;
  ownedCompanyIds: number[];
  sessionCompanyId: number;
}): { allowed: boolean; reason: string } {
  const { account, requestedCompanies, ownedCompanyIds, sessionCompanyId } = params;
  if (!account || account.status !== "active") return { allowed: false, reason: "account_unavailable" };
  if (!["owner", "admin", "member", "billing"].includes(account.member_role)) {
    return { allowed: false, reason: "membership_invalid" };
  }
  if (!["active", "trialing"].includes(account.subscription_status || "")) {
    return { allowed: false, reason: "subscription_inactive" };
  }
  if (!["retail", "business", "factory", "enterprise"].includes(account.plan || "")) {
    return { allowed: false, reason: "plan_invalid" };
  }
  if (!Number.isSafeInteger(sessionCompanyId) || !ownedCompanyIds.includes(sessionCompanyId)) {
    return { allowed: false, reason: "session_company_mismatch" };
  }
  if (!requestedCompanies || requestedCompanies.some(id => !ownedCompanyIds.includes(id))) {
    return { allowed: false, reason: "cross_account_company" };
  }
  return { allowed: true, reason: "admitted" };
}

/**
 * Expected to run in a dedicated commercial deployment. Account membership
 * is resolved from the server-side authenticated session, never a header.
 * The query intentionally has no Developer bypass.
 */
async function accountLookup(userId: string, companyId: number): Promise<AccountRow[]> {
  const rows = await db.execute(sql<AccountRow>`
    SELECT a.id, a.status, s.plan, s.status AS subscription_status, m.role AS member_role
    FROM commercial_accounts a
    JOIN commercial_account_companies c ON c.account_id = a.id
    JOIN commercial_account_members m ON m.account_id = a.id
    LEFT JOIN commercial_subscriptions s ON s.account_id = a.id
    WHERE c.company_id = ${companyId} AND m.user_id = ${userId}
    LIMIT 2
  `);
  return Array.from(rows.rows as AccountRow[]);
}
async function ownedCompanies(accountId: string): Promise<number[]> {
  const rows = await db.execute(sql<{ company_id: number }>`
    SELECT company_id FROM commercial_account_companies WHERE account_id = ${accountId}
  `);
  return rows.rows.map(row => Number(row.company_id));
}

export function makeCommercialAdmissionBoundary(
  lookup: Lookup = accountLookup,
  loadCompanies: (accountId: string) => Promise<number[]> = ownedCompanies
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!commercialModeEnabled() || !req.path.startsWith("/api/")) {
      next();
      return;
    }
    if (process.env.DAKZO_COMMERCIAL_ISOLATED_DATABASE !== "confirmed") {
      res.status(503).json({ code: "COMMERCIAL_ISOLATION_NOT_CERTIFIED" });
      return;
    }
    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }
    // Explicit deny until individually audited; no global Developer bypass.
    if (UNSUPPORTED_PATHS.some(pattern => pattern.test(req.path))) {
      res.status(403).json({ code: "COMMERCIAL_ROUTE_UNSUPPORTED" });
      return;
    }
    const userId = req.session?.userId;
    const companyId = req.session?.currentCompanyId;
    if (!userId || !Number.isSafeInteger(companyId) || Number(companyId) <= 0) {
      res.status(401).json({ code: "COMMERCIAL_SESSION_REQUIRED" });
      return;
    }
    try {
      const records = await lookup(userId, Number(companyId));
      if (records.length !== 1) {
        res.status(403).json({ code: "COMMERCIAL_MEMBERSHIP_REQUIRED" });
        return;
      }
      const owned = await loadCompanies(records[0].id);
      const bodyIds = scanCompanyIdentifiers(req.body);
      const queryIds = scanCompanyIdentifiers(req.query);
      const pathIds = scanCompanyIdentifiers(req.params);
      const requested = bodyIds && queryIds && pathIds ? [...bodyIds, ...queryIds, ...pathIds] : null;
      const result = decideCommercialAccountAdmission({
        account: records[0],
        requestedCompanies: requested,
        ownedCompanyIds: owned,
        sessionCompanyId: Number(companyId),
      });
      if (!result.allowed) {
        res.status(403).json({ code: "COMMERCIAL_ACCESS_DENIED" });
        return;
      }
      next();
    } catch {
      res.status(503).json({ code: "COMMERCIAL_ACCOUNT_GATE_UNAVAILABLE" });
    }
  };
}
