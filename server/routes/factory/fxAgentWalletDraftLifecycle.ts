/**
 * Optional on/off for a direct EUR payment out of an FX agent wallet.
 *
 * Optional ON  = an off-ledger EUR draft: no wallet EUR is deducted.
 * Optional OFF = the atomic wallet settlement (Payment voucher + EUR movement).
 *
 * Turning a draft OFF runs the settlement and retires the draft; turning a
 * posted payment ON cancels the settlement (EUR and supplier restored) and
 * leaves an equivalent Optional draft, all in one transaction.
 */
import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { toMoney } from "../../lib/money";
import {
  postPaymentReceiptVoucherTx,
  writePaymentReceiptDaybookEntry,
} from "../../services/accounting/paymentReceiptVoucherPosting";
import { cancelFxAgentSettlementVoucherTx } from "../../services/factory/fxAgentSettlementCancellation";
import { registerFactoryFxAgentSettlementRoutesPart1 } from "./registerFactoryFxAgentSettlementRoutesPart1";

const FX_ROLES = ["Admin", "Owner", "Developer"];
const { settleWalletPayment } = registerFactoryFxAgentSettlementRoutesPart1();

function sessionCompanyId(req: Request): number {
  return Number(req.session?.factoryCompanyId || req.session?.currentCompanyId || 0);
}

async function walletTablesExist(): Promise<boolean> {
  const table = await db.execute(sql`SELECT to_regclass('factory_fx_agent_wallets')::text AS name`);
  return !!table.rows[0]?.name;
}

export type FxWalletDraft = {
  id: number;
  date: string;
  description: string;
  currency: string;
  exchangeRate: string | null;
  walletId: number;
  walletLedgerId: number;
  sourceCurrency: string;
  sourceEur: string;
  supplierId: number | null;
  recipientCurrency: string | null;
  recipientEur: string | null;
  lineCount: number;
};

/** The Optional Payment draft that credits an FX agent wallet ledger, if this voucher is one. */
export async function loadFxWalletDraft(companyId: number, voucherId: number): Promise<FxWalletDraft | null> {
  if (!companyId || !Number.isSafeInteger(voucherId) || voucherId < 1) return null;
  if (!(await walletTablesExist())) return null;
  const draft = await db.execute(sql`
    SELECT v.id, to_char(v.voucher_date, 'YYYY-MM-DD') AS date, v.description, v.currency,
      v.exchange_rate::text AS "exchangeRate",
      w.id AS "walletId", w.ledger_account_id AS "walletLedgerId",
      src.transaction_currency AS "sourceCurrency",
      src.transaction_credit_amount::text AS "sourceEur",
      dst.factory_supplier_id AS "supplierId",
      dst.transaction_currency AS "recipientCurrency",
      dst.transaction_debit_amount::text AS "recipientEur",
      (SELECT COUNT(*)::int FROM voucher_entries e WHERE e.voucher_id = v.id) AS "lineCount"
    FROM vouchers v
    JOIN voucher_entries src ON src.voucher_id = v.id AND src.credit_amount > 0
    JOIN factory_fx_agent_wallets w ON w.company_id = v.company_id
      AND w.ledger_account_id = src.ledger_account_id
    LEFT JOIN voucher_entries dst ON dst.voucher_id = v.id
      AND dst.debit_amount > 0 AND dst.factory_supplier_id IS NOT NULL
    WHERE v.id = ${voucherId} AND v.company_id = ${companyId}
      AND v.optional = true AND v.deleted_at IS NULL
      AND v.voucher_type = 'Payment'
    LIMIT 1
  `);
  const row = draft.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    date: String(row.date),
    description: String(row.description || ""),
    currency: String(row.currency || "USD"),
    exchangeRate: row.exchangeRate === null ? null : String(row.exchangeRate),
    walletId: Number(row.walletId),
    walletLedgerId: Number(row.walletLedgerId),
    sourceCurrency: String(row.sourceCurrency || ""),
    sourceEur: String(row.sourceEur ?? "0"),
    supplierId: row.supplierId ? Number(row.supplierId) : null,
    recipientCurrency: row.recipientCurrency ? String(row.recipientCurrency) : null,
    recipientEur: row.recipientEur === null || row.recipientEur === undefined ? null : String(row.recipientEur),
    lineCount: Number(row.lineCount),
  };
}

/**
 * Turn an Optional EUR wallet draft OFF: post the settlement and retire the draft.
 * Calls next() only when the voucher is not an FX wallet draft at all, so an FX
 * draft can never be activated as an ordinary ledger Payment.
 */
export async function finalizeFxWalletDraft(req: Request, res: Response, next: NextFunction) {
  const cid = sessionCompanyId(req);
  const id = Number(req.params.id);
  try {
    const draft = await loadFxWalletDraft(cid, id);
    if (!draft) return next();
    if (!FX_ROLES.includes(String(req.session.currentRole))) {
      return res.status(403).json({ message: "Only Admin and Owner can finalize FX wallet payments" });
    }
    if (
      draft.currency !== "EUR" ||
      draft.sourceCurrency !== "EUR" ||
      draft.recipientCurrency !== "EUR" ||
      !draft.supplierId ||
      draft.lineCount !== 2 ||
      draft.recipientEur === null ||
      !toMoney(draft.recipientEur).eq(draft.sourceEur) ||
      toMoney(draft.sourceEur).lte(0)
    ) {
      return res.status(409).json({
        code: "FX_WALLET_DRAFT_INVALID",
        message:
          "This Optional FX wallet voucher is not a single direct EUR supplier payment, so it cannot be posted. Delete it and enter the payment again.",
      });
    }
    req.params.id = String(draft.walletId);
    req.body = {
      paymentVoucher: true,
      targetCurrency: "EUR",
      eurAmount: toMoney(draft.recipientEur).toFixed(2),
      targetKind: "factorySupplier",
      targetId: draft.supplierId,
      date: draft.date,
      requestKey: `fx-optional-${cid}-${id}`,
      narration: draft.description,
      draftVoucherId: id,
    };
    return settleWalletPayment(req, res);
  } catch (error) {
    return res.status(400).json({ message: getErrorMessage(error) });
  }
}

/**
 * Turn a posted direct EUR wallet payment back ON (Optional): cancel the
 * settlement and keep an equivalent off-ledger draft. Returns the new draft
 * voucher id, or null when the voucher is not a direct EUR wallet payment.
 */
export async function revertFxEurPaymentToDraft(req: Request, voucherId: number): Promise<number | null> {
  const cid = sessionCompanyId(req);
  if (!cid || !Number.isSafeInteger(voucherId) || voucherId < 1) return null;
  if (!(await walletTablesExist())) return null;
  const ops = await db.execute(sql`
    SELECT op.kind, op.target_currency AS "targetCurrency", op.target_kind AS "targetKind",
      op.target_id AS "targetId", op.source_amount::text AS eur,
      op.source_book_usd::text AS "bookUsd", op.narration,
      w.ledger_account_id AS "walletLedgerId",
      to_char(v.voucher_date, 'YYYY-MM-DD') AS date, v.description, v.voucher_type AS "voucherType",
      v.optional, v.deleted_at AS "deletedAt"
    FROM factory_fx_agent_wallet_operations op
    JOIN factory_fx_agent_wallets w ON w.id = op.wallet_id AND w.company_id = op.company_id
    JOIN vouchers v ON v.id = op.voucher_id AND v.company_id = op.company_id
    WHERE op.company_id = ${cid} AND op.voucher_id = ${voucherId}
  `);
  if (!ops.rows.length) return null;
  const op = ops.rows[0];
  if (!FX_ROLES.includes(String(req.session.currentRole))) {
    throw Object.assign(new Error("Only Admin and Owner can change FX wallet payments"), { status: 403 });
  }
  if (
    ops.rows.length !== 1 ||
    op.kind !== "EUR_SETTLEMENT" ||
    op.targetCurrency !== "EUR" ||
    op.targetKind !== "factorySupplier" ||
    op.voucherType !== "Payment" ||
    op.optional === true ||
    op.deletedAt
  ) {
    throw Object.assign(
      new Error(
        "Only a direct EUR supplier payment from the FX wallet can be made Optional. A USD payout locks its agreed rate; delete it and enter it again instead."
      ),
      { status: 409 }
    );
  }
  const eur = toMoney(String(op.eur));
  const bookUsd = toMoney(String(op.bookUsd));
  if (eur.lte(0) || bookUsd.lte(0)) throw new Error("FX payment book value is unavailable");
  const description = String(op.narration || "") || `Payment (optional EUR FX draft)`;
  const draft = await db.transaction(async (tx) => {
    const cancelled = await cancelFxAgentSettlementVoucherTx({
      tx,
      companyId: cid,
      voucherId,
      actor: { userId: req.session.userId!, username: req.session.username || "unknown" },
      asOfDate: getClientDate(req),
    });
    if (!cancelled) throw new Error("FX payment link changed. Reload and try again");
    const posted = await postPaymentReceiptVoucherTx(tx, {
      companyId: cid,
      voucherType: "Payment",
      voucherDate: String(op.date),
      paymentAccountType: "ledger",
      paymentAccountId: Number(op.walletLedgerId),
      entries: [{ accountType: "factorySupplier", accountId: Number(op.targetId), amount: eur.toFixed(2) }],
      notes: description,
      optional: true,
      currency: "EUR",
      exchangeRate: eur.div(bookUsd).toDecimalPlaces(10).toFixed(10),
      effectiveDate: null,
      sourceId: `${cid}:fx-optional-revert-${voucherId}`,
      actor: { userId: req.session.userId, username: req.session.username },
      reason: "FX EUR payment made Optional",
    });
    return posted.voucher;
  });
  try {
    await writePaymentReceiptDaybookEntry(db, cid, draft);
  } catch (error) {
    logger.error("Factory daybook write failed (non-fatal):", { error });
  }
  return draft.id;
}
