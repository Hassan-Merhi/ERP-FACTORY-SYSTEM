import type { Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { intercompanyAccountLinks, userCompanyRoles } from "@shared/schema";
import { db } from "../db";
import { logger } from "../lib/logger";
import {
  canManageIntercompanyCompany,
  canManageIntercompanyPair,
  ledgersMatchIntercompanyPair,
  type IntercompanyActorScope,
} from "../services/security/intercompanyConfigurationPolicy";

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function optionalPositiveId(
  body: Record<string, unknown> | undefined,
  key: string
): { provided: false } | { provided: true; value: number | null } {
  if (!body || body[key] === undefined) return { provided: false };
  return { provided: true, value: positiveId(body[key]) };
}

async function loadActorScope(userId: string): Promise<IntercompanyActorScope> {
  const roles = await db
    .select({ companyId: userCompanyRoles.companyId, role: userCompanyRoles.role })
    .from(userCompanyRoles)
    .where(eq(userCompanyRoles.userId, userId));
  return {
    isDeveloper: roles.some((row) => row.role === "Developer"),
    companyRoles: new Map(roles.map((row) => [row.companyId, row.role])),
  };
}

async function loadLink(linkId: number) {
  const [link] = await db
    .select()
    .from(intercompanyAccountLinks)
    .where(eq(intercompanyAccountLinks.id, linkId))
    .limit(1);
  return link ?? null;
}

async function ledgersBelongToPair(input: {
  sourceLedgerAccountId: number;
  destLedgerAccountId: number;
  sourceCompanyId: number;
  destCompanyId: number;
}): Promise<boolean> {
  // The two accounts belong to two companies, and the request's tenant scope
  // (one company) cannot see the other's under row-level security: ownership is
  // read through the narrow erp_ledger_account_owners probe (ids and owners
  // only; phases 23–29 integration, ledgerModelSchema.ts).
  const result = await db.execute(
    sql`SELECT account_id, company_id
          FROM erp_ledger_account_owners(ARRAY[${input.sourceLedgerAccountId}, ${input.destLedgerAccountId}]::integer[])`
  );
  const companyByLedger = new Map(
    (result.rows as Array<{ account_id: number; company_id: number }>).map((row) => [
      Number(row.account_id),
      Number(row.company_id),
    ])
  );
  return ledgersMatchIntercompanyPair(
    companyByLedger.get(input.sourceLedgerAccountId),
    companyByLedger.get(input.destLedgerAccountId),
    input.sourceCompanyId,
    input.destCompanyId
  );
}

function installLinkFilter(res: Response, scope: IntercompanyActorScope): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (!Array.isArray(body)) return originalJson(body);
    return originalJson(
      body.filter((row) => canManageIntercompanyPair(scope, Number(row?.sourceCompanyId), Number(row?.destCompanyId)))
    );
  };
}

function deny(
  req: Request,
  res: Response,
  reason: string,
  status = 404,
  message = "Intercompany configuration not found"
): false {
  logger.error(
    JSON.stringify({
      event: "intercompany_configuration_scope_denied",
      ts: new Date().toISOString(),
      userId: req.session.userId ?? null,
      role: req.session.currentRole ?? null,
      companyId: req.session.currentCompanyId ?? null,
      method: req.method,
      path: req.path,
      reason,
    })
  );
  res.status(status).json({ message });
  return false;
}

export async function enforceIntercompanyConfigurationScope(req: Request, res: Response): Promise<boolean> {
  const userId = req.session.userId;
  if (!userId) return true;

  const method = req.method.toUpperCase();
  const path = req.path;
  const isRelevant =
    path === "/api/intercompany-links" ||
    /^\/api\/intercompany-links\/\d+(?:\/recipients)?$/.test(path) ||
    /^\/api\/companies\/\d+\/member-ids$/.test(path);
  if (!isRelevant) return true;

  const scope = await loadActorScope(userId);

  if (method === "GET" && path === "/api/intercompany-links") {
    installLinkFilter(res, scope);
    return true;
  }

  const memberIdsMatch = path.match(/^\/api\/companies\/(\d+)\/member-ids$/);
  if (method === "GET" && memberIdsMatch) {
    const targetCompanyId = Number(memberIdsMatch[1]);
    if (!canManageIntercompanyCompany(scope, targetCompanyId)) {
      return deny(req, res, "MEMBER_LIST_COMPANY_SCOPE_DENIED", 404, "Company not found");
    }
    return true;
  }

  const body = req.body as Record<string, unknown> | undefined;

  if (method === "POST" && path === "/api/intercompany-links") {
    const sourceCompanyId = positiveId(body?.sourceCompanyId);
    const destCompanyId = positiveId(body?.destCompanyId);
    const sourceLedgerAccountId = positiveId(body?.sourceLedgerAccountId);
    const destLedgerAccountId = positiveId(body?.destLedgerAccountId);
    if (
      sourceCompanyId == null ||
      destCompanyId == null ||
      sourceLedgerAccountId == null ||
      destLedgerAccountId == null
    ) {
      return true;
    }

    if (!canManageIntercompanyPair(scope, sourceCompanyId, destCompanyId)) {
      return deny(req, res, "INTERCOMPANY_PAIR_SCOPE_DENIED", 403, "Access denied");
    }
    if (
      !(await ledgersBelongToPair({
        sourceCompanyId,
        destCompanyId,
        sourceLedgerAccountId,
        destLedgerAccountId,
      }))
    ) {
      return deny(req, res, "INTERCOMPANY_LEDGER_SCOPE_DENIED", 400, "Invalid intercompany accounts");
    }
    return true;
  }

  const linkMatch = path.match(/^\/api\/intercompany-links\/(\d+)(?:\/recipients)?$/);
  if (!linkMatch) return true;
  const linkId = Number(linkMatch[1]);
  const link = await loadLink(linkId);
  if (!link) return true;

  const sourceCompanyInput = optionalPositiveId(body, "sourceCompanyId");
  const destCompanyInput = optionalPositiveId(body, "destCompanyId");
  if (
    (sourceCompanyInput.provided && sourceCompanyInput.value == null) ||
    (destCompanyInput.provided && destCompanyInput.value == null)
  ) {
    return deny(req, res, "INTERCOMPANY_COMPANY_ID_INVALID", 400, "Invalid company ID");
  }

  const sourceCompanyId = sourceCompanyInput.provided ? sourceCompanyInput.value! : link.sourceCompanyId;
  const destCompanyId = destCompanyInput.provided ? destCompanyInput.value! : link.destCompanyId;
  if (!canManageIntercompanyPair(scope, sourceCompanyId, destCompanyId)) {
    return deny(req, res, "INTERCOMPANY_LINK_SCOPE_DENIED");
  }

  if (method === "PUT") {
    const sourceLedgerInput = optionalPositiveId(body, "sourceLedgerAccountId");
    const destLedgerInput = optionalPositiveId(body, "destLedgerAccountId");
    if (
      (sourceLedgerInput.provided && sourceLedgerInput.value == null) ||
      (destLedgerInput.provided && destLedgerInput.value == null)
    ) {
      return deny(req, res, "INTERCOMPANY_LEDGER_ID_INVALID", 400, "Invalid ledger account ID");
    }

    const sourceLedgerAccountId = sourceLedgerInput.provided ? sourceLedgerInput.value! : link.sourceLedgerAccountId;
    const destLedgerAccountId = destLedgerInput.provided ? destLedgerInput.value! : link.destLedgerAccountId;
    if (
      !(await ledgersBelongToPair({
        sourceCompanyId,
        destCompanyId,
        sourceLedgerAccountId,
        destLedgerAccountId,
      }))
    ) {
      return deny(req, res, "INTERCOMPANY_LEDGER_SCOPE_DENIED", 400, "Invalid intercompany accounts");
    }
  }

  return true;
}
