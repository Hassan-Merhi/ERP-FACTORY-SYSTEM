/**
 * Phase 3 — signed dispatch charge drafts and financial preview ONLY.
 * This module must not create invoices, journals, stock movements or payments.
 * Phase 4 owns the actual POST/REVERSAL transition and accounting engine.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getFactoryAccessState, requireFactoryTabAccess } from "../../../lib/factoryAccessControl";
import { parseId } from "../../../lib/parseId";
import { resultRows } from "../../../lib/queryResult";
import { logger } from "../../../lib/logger";
import {
  DispatchFinancialSourceError, loadDispatchTripFinancialSource,
} from "../../../services/factory/dispatchTripFinancialSource";
import {
  accountAcceptsCharge, accountAcceptsOffset, buildTripChargePreview,
  TripChargeValidationError, tripChargeFingerprint, validChargeInput,
  type TripChargeRow, type TripChargeKind, type ErpChargeType,
} from "./loadingDispatchFinancialChargeModel";

const loadingsAccess = requireFactoryTabAccess("factory/invoicing", "hide_invoicing_loadings_tab");
const BASE = "/api/factory/customer-orders/:id/loading-dispatches/:dispatchId";

class FinancialChargeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
function fail(status: number, code: string, message: string): never {
  throw new FinancialChargeHttpError(status, code, message);
}
function safeId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(400, "INVALID_ID", "Invalid record identifier");
  return n;
}
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(409, "INVALID_STORED_ID", "A financial record has an invalid account or row ID");
  return n;
}
function text(value: unknown): string { return value === null || value === undefined ? "" : String(value); }

interface Scope {
  companyId: number;
  orderId: number;
  dispatchId: number;
  userId: string;
  username: string;
  role: string;
}
async function requestScope(req: Request): Promise<Scope> {
  const state = await getFactoryAccessState(req);
  if (!state?.hasFactoryAccess) fail(403, "FACTORY_ACCESS_REQUIRED", "Factory access required");
  const orderId = parseId(req.params.id);
  const dispatchId = parseId(req.params.dispatchId);
  if (orderId === null || dispatchId === null) fail(400, "INVALID_ID", "Invalid order or dispatch");
  const role = state.role.trim().toLowerCase();
  if (!["admin", "owner", "developer"].includes(role)) {
    fail(403, "FINANCIAL_ACCESS_REQUIRED", "Trip financial charges are available to Admin, Owner and Developer");
  }
  return {
    companyId: state.companyId, orderId, dispatchId, role,
    userId: state.userId, username: text(req.session.username || state.userId),
  };
}

interface FinancialRow {
  id: number;
  status: string;
  postingRevision: number;
  currency: string;
}
async function loadFinancial(tx: DbTransaction, scope: Scope, lock = false): Promise<FinancialRow | null> {
  const records = resultRows(await tx.execute(sql`
    SELECT id, status, posting_revision AS "postingRevision", currency
      FROM factory_dispatch_trip_financials
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND dispatch_id = ${scope.dispatchId}
     ${lock ? sql`FOR UPDATE` : sql``}
  `));
  const row = records[0];
  return row ? {
    id: safeId(row.id), status: text(row.status),
    postingRevision: Number(row.postingRevision), currency: text(row.currency),
  } : null;
}
function relevantRevision(financial: FinancialRow | null): number {
  return financial && ["POSTED", "CONSOLIDATED"].includes(financial.status)
    ? financial.postingRevision : (financial?.postingRevision ?? 0) + 1;
}
async function loadCharges(tx: DbTransaction, scope: Scope, financial: FinancialRow | null): Promise<TripChargeRow[]> {
  if (!financial) return [];
  const revision = relevantRevision(financial);
  const rows = resultRows(await tx.execute(sql`
    SELECT id, name, kind, amount::text, currency,
           ledger_account_id AS "ledgerAccountId",
           offset_ledger_account_id AS "offsetLedgerAccountId",
           erp_charge_type AS "erpChargeType", notes, revision,
           locked_at AS "lockedAt", updated_at AS "updatedAt"
      FROM factory_dispatch_trip_charges
     WHERE financial_id = ${financial.id} AND company_id = ${scope.companyId}
       AND order_id = ${scope.orderId} AND dispatch_id = ${scope.dispatchId}
       AND revision = ${revision}
     ORDER BY id
  `));
  return rows.map(row => ({
    id: safeId(row.id),
    name: text(row.name),
    kind: text(row.kind) as TripChargeKind,
    amount: text(row.amount),
    currency: text(row.currency),
    ledgerAccountId: safeId(row.ledgerAccountId),
    offsetLedgerAccountId: numberOrNull(row.offsetLedgerAccountId),
    erpChargeType: (row.erpChargeType || null) as ErpChargeType,
    notes: row.notes == null ? null : text(row.notes),
    revision: Number(row.revision),
    lockedAt: row.lockedAt == null ? null : text(row.lockedAt),
    updatedAt: row.updatedAt == null ? null : text(row.updatedAt),
  }));
}
interface Account {
  id: number;
  code: string;
  name: string;
  accountType: string;
}
async function loadAccounts(tx: DbTransaction, companyId: number): Promise<Account[]> {
  const rows = resultRows(await tx.execute(sql`
    SELECT id, code, name, account_type AS "accountType"
      FROM ledger_accounts
     WHERE company_id = ${companyId} AND active = TRUE
       AND deleted_at IS NULL AND is_hidden = FALSE
     ORDER BY name, id LIMIT 2000
  `));
  return rows.map(a => ({
    id: safeId(a.id), code: text(a.code), name: text(a.name),
    accountType: text(a.accountType),
  }));
}
function validateAccounts(
  input: ReturnType<typeof validChargeInput>, accounts: Account[]
): void {
  const own = accounts.find(a => a.id === input.ledgerAccountId);
  if (!own || !accountAcceptsCharge(input.kind, own.accountType)) {
    fail(400, "LEDGER_ACCOUNT_INVALID", "Select an active company-owned account appropriate to this charge category");
  }
  if (input.offsetLedgerAccountId !== null) {
    const offset = accounts.find(a => a.id === input.offsetLedgerAccountId);
    if (!offset || !accountAcceptsOffset(offset.accountType)) {
      fail(400, "OFFSET_ACCOUNT_INVALID", "Select an active company-owned payable, cash or clearing offset account");
    }
  }
}

async function orderAndTripLock(tx: DbTransaction, scope: Scope): Promise<void> {
  const orders = resultRows(await tx.execute(sql`
    SELECT id, status, deleted_at AS "deletedAt"
      FROM customer_orders
     WHERE company_id = ${scope.companyId} AND id = ${scope.orderId}
     FOR UPDATE
  `));
  if (!orders[0] || orders[0].deletedAt ||
      !["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(text(orders[0].status))) {
    fail(409, "ORDER_NOT_ACTIVE", "Pending Loading must remain active to edit trip charges");
  }
  const trips = resultRows(await tx.execute(sql`
    SELECT id, status FROM factory_loading_dispatches
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND id = ${scope.dispatchId} FOR UPDATE
  `));
  if (!trips[0]) fail(404, "DISPATCH_NOT_FOUND", "Trip not found in this Factory loading");
  if (trips[0].status !== "CLOSED") fail(409, "DISPATCH_NOT_CLOSED", "End Dispatch before editing its financial charges");
}

async function editableFinancial(tx: DbTransaction, scope: Scope): Promise<FinancialRow | null> {
  const row = await loadFinancial(tx, scope, true);
  if (row && !["DRAFT", "REVERSED"].includes(row.status)) {
    fail(409, "FINANCIAL_LOCKED", "This trip is financially posted. Use the approved reversal workflow before changing charges");
  }
  if (row && row.currency !== "USD") {
    fail(409, "CURRENCY_UNSUPPORTED", "Phase 3 only permits USD charge drafts until exchange-rate posting is implemented");
  }
  return row;
}
function requireFingerprint(body: Record<string, unknown>, charges: TripChargeRow[], sourceFingerprint: string): void {
  if (body.expectedChargeFingerprint !== tripChargeFingerprint(charges) ||
      body.expectedSourceFingerprint !== sourceFingerprint) {
    fail(409, "FINANCIAL_PREVIEW_CHANGED", "Trip or charge amounts changed. Refresh the financial preview before saving");
  }
}
async function logChange(
  tx: DbTransaction, scope: Scope, financialId: number, eventType: string, data: Record<string, unknown>
) {
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events (
      company_id, order_id, dispatch_id, financial_id,
      event_type, details, actor_user_id, actor_username
    ) VALUES (
      ${scope.companyId}, ${scope.orderId}, ${scope.dispatchId}, ${financialId},
      ${eventType}, ${JSON.stringify(data)}::jsonb, ${scope.userId}, ${scope.username}
    )
  `);
}
function sendFailure(res: Response, error: unknown) {
  if (error instanceof FinancialChargeHttpError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof TripChargeValidationError) {
    return res.status(400).json({ code: "INVALID_TRIP_CHARGE", message: error.message });
  }
  if (error instanceof DispatchFinancialSourceError) {
    return res.status(409).json({ code: error.code, message: error.message });
  }
  if ((error as { code?: string } | null)?.code === "42P01") {
    return res.status(503).json({
      code: "TRIP_FINANCIAL_SCHEMA_PENDING",
      message: "Trip financial tables are not installed yet. Apply the final TablePlus SQL package before using charges.",
    });
  }
  logger.error("Factory trip financial charge request failed", { error });
  return res.status(500).json({ code: "TRIP_CHARGE_ERROR", message: "Unable to process Factory trip financial charges" });
}
function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(400, "INVALID_BODY", "Invalid charge request");
  }
  return value as Record<string, unknown>;
}

/** List/preview never creates financial rows or mutates the order. */
export function registerFactoryLoadingDispatchFinancialRoutes(app: Express): void {
  app.get(BASE + "/financial-preview", requireAuth, loadingsAccess, async (req, res) => {
    try {
      const scope = await requestScope(req);
      const preview = await db.transaction(async tx => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        // The financial table may not exist until the owner runs the final SQL.
        const financial = await loadFinancial(tx, scope);
        const [charges, accounts] = await Promise.all([
          loadCharges(tx, scope, financial),
          loadAccounts(tx, scope.companyId),
        ]);
        let source: Awaited<ReturnType<typeof loadDispatchTripFinancialSource>> | null = null;
        let sourceError: { code: string; message: string } | null = null;
        try {
          source = await loadDispatchTripFinancialSource(
            tx, scope.companyId, scope.orderId, scope.dispatchId,
          );
        } catch (error) {
          if (!(error instanceof DispatchFinancialSourceError)) throw error;
          sourceError = { code: error.code, message: error.message };
        }
        const totals = source ? buildTripChargePreview(source.goodsSubtotal, charges) : null;
        return {
          status: financial?.status ?? "DRAFT",
          currency: financial?.currency ?? "USD",
          revision: relevantRevision(financial),
          source, sourceError, totals, charges,
          chargeFingerprint: tripChargeFingerprint(charges),
          accounts,
          canEdit: Boolean(source && (!financial || ["DRAFT", "REVERSED"].includes(financial.status))),
          postingEnabled: false,
          postingNotice: "Financial finalization and account posting will be enabled in Phase 4.",
        };
      });
      res.set("Cache-Control", "private, no-store");
      return res.json(preview);
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  app.post(BASE + "/financial-charges", requireAuth, loadingsAccess, async (req, res) => {
    try {
      const scope = await requestScope(req);
      const body = bodyObject(req.body);
      const charge = validChargeInput(body.charge);
      const result = await db.transaction(async tx => {
        await orderAndTripLock(tx, scope);
        const source = await loadDispatchTripFinancialSource(tx, scope.companyId, scope.orderId, scope.dispatchId);
        let financial = await editableFinancial(tx, scope);
        const charges = await loadCharges(tx, scope, financial);
        requireFingerprint(body, charges, source.sourceFingerprint);
        const accounts = await loadAccounts(tx, scope.companyId);
        validateAccounts(charge, accounts);
        buildTripChargePreview(source.goodsSubtotal, [
          ...charges,
          { ...charge, id: -1, currency: "USD", revision: relevantRevision(financial), lockedAt: null },
        ]);
        if (!financial) {
          const rows = resultRows(await tx.execute(sql`
            INSERT INTO factory_dispatch_trip_financials (company_id, order_id, dispatch_id, status)
            VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId}, 'DRAFT')
            RETURNING id, status, posting_revision AS "postingRevision", currency
          `));
          const row = rows[0];
          financial = { id: safeId(row.id), status: text(row.status), postingRevision: Number(row.postingRevision), currency: text(row.currency) };
        }
        const inserted = resultRows(await tx.execute(sql`
          INSERT INTO factory_dispatch_trip_charges (
            financial_id, company_id, order_id, dispatch_id,
            revision, name, kind, amount, currency,
            ledger_account_id, offset_ledger_account_id, erp_charge_type, notes
          ) VALUES (
            ${financial.id}, ${scope.companyId}, ${scope.orderId}, ${scope.dispatchId},
            ${relevantRevision(financial)}, ${charge.name}, ${charge.kind}, ${charge.amount}, 'USD',
            ${charge.ledgerAccountId}, ${charge.offsetLedgerAccountId}, ${charge.erpChargeType}, ${charge.notes}
          ) RETURNING id
        `));
        await logChange(tx, scope, financial.id, "TRIP_CHARGE_CREATED", {
          chargeId: text(inserted[0]?.id), ...charge, sourceFingerprint: source.sourceFingerprint,
        });
        return { chargeId: text(inserted[0]?.id) };
      });
      return res.status(201).json(result);
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  app.patch(BASE + "/financial-charges/:chargeId", requireAuth, loadingsAccess, async (req, res) => {
    try {
      const scope = await requestScope(req);
      const chargeId = safeId(req.params.chargeId);
      const body = bodyObject(req.body);
      const next = validChargeInput(body.charge);
      await db.transaction(async tx => {
        await orderAndTripLock(tx, scope);
        const source = await loadDispatchTripFinancialSource(tx, scope.companyId, scope.orderId, scope.dispatchId);
        const financial = await editableFinancial(tx, scope);
        if (!financial) fail(404, "CHARGE_NOT_FOUND", "This trip has no draft financial charges");
        const charges = await loadCharges(tx, scope, financial);
        requireFingerprint(body, charges, source.sourceFingerprint);
        const previous = charges.find(c => c.id === chargeId && !c.lockedAt);
        if (!previous) fail(404, "CHARGE_NOT_EDITABLE", "Charge is missing or belongs to a locked revision");
        validateAccounts(next, await loadAccounts(tx, scope.companyId));
        buildTripChargePreview(source.goodsSubtotal, [
          ...charges.filter(c => c.id !== chargeId),
          { ...next, id: chargeId, currency: "USD", revision: previous.revision, lockedAt: null },
        ]);
        const affected = resultRows(await tx.execute(sql`
          UPDATE factory_dispatch_trip_charges
             SET name = ${next.name}, kind = ${next.kind}, amount = ${next.amount},
                 ledger_account_id = ${next.ledgerAccountId},
                 offset_ledger_account_id = ${next.offsetLedgerAccountId},
                 erp_charge_type = ${next.erpChargeType}, notes = ${next.notes},
                 updated_at = NOW()
           WHERE financial_id = ${financial.id} AND company_id = ${scope.companyId}
             AND order_id = ${scope.orderId} AND dispatch_id = ${scope.dispatchId}
             AND id = ${chargeId} AND revision = ${relevantRevision(financial)}
             AND locked_at IS NULL RETURNING id
        `));
        if (!affected[0]) fail(409, "CHARGE_CHANGED", "Charge changed; refresh your preview");
        await logChange(tx, scope, financial.id, "TRIP_CHARGE_UPDATED", {
          chargeId, previous, next, sourceFingerprint: source.sourceFingerprint,
        });
      });
      return res.json({ updated: true });
    } catch (error) {
      return sendFailure(res, error);
    }
  });

  app.delete(BASE + "/financial-charges/:chargeId", requireAuth, loadingsAccess, async (req, res) => {
    try {
      const scope = await requestScope(req);
      const chargeId = safeId(req.params.chargeId);
      const body = bodyObject(req.body);
      await db.transaction(async tx => {
        await orderAndTripLock(tx, scope);
        const source = await loadDispatchTripFinancialSource(tx, scope.companyId, scope.orderId, scope.dispatchId);
        const financial = await editableFinancial(tx, scope);
        if (!financial) fail(404, "CHARGE_NOT_FOUND", "This trip has no draft charges");
        const charges = await loadCharges(tx, scope, financial);
        requireFingerprint(body, charges, source.sourceFingerprint);
        const previous = charges.find(c => c.id === chargeId && !c.lockedAt);
        if (!previous) fail(404, "CHARGE_NOT_EDITABLE", "Charge is missing or belongs to a locked revision");
        const removed = resultRows(await tx.execute(sql`
          DELETE FROM factory_dispatch_trip_charges
           WHERE financial_id = ${financial.id} AND company_id = ${scope.companyId}
             AND order_id = ${scope.orderId} AND dispatch_id = ${scope.dispatchId}
             AND id = ${chargeId} AND revision = ${relevantRevision(financial)}
             AND locked_at IS NULL RETURNING id
        `));
        if (!removed[0]) fail(409, "CHARGE_CHANGED", "Charge changed; refresh your preview");
        await logChange(tx, scope, financial.id, "TRIP_CHARGE_REMOVED", {
          chargeId, previous, sourceFingerprint: source.sourceFingerprint,
        });
      });
      return res.json({ deleted: true });
    } catch (error) {
      return sendFailure(res, error);
    }
  });
}
