/**
 * An FX agent's posted USD ledger is the book basis, not spendable USD.
 * Generic Payment creation must use the atomic FX wallet settlement path
 * instead of crediting this ledger as if it were a USD bank account.
 */
import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { applyPaymentReceiptEditTx, paymentReceiptEditPlan } from "../../services/accounting/paymentReceiptVoucherEdit";
import {
  finalizeFxWalletDraft,
  loadFxWalletDraft,
  revertFxEurPaymentToDraft,
  type FxWalletDraft,
} from "../factory/fxAgentWalletDraftLifecycle";

const FX_DRAFT_ROLES = ["Admin", "Owner", "Developer"];

export async function guardFxWalletPaymentSource(req: Request, res: Response, next: NextFunction) {
  if (
    req.method !== "POST" ||
    req.body?.voucherType !== "Payment" ||
    req.body?.paymentAccountType !== "ledger" ||
    !req.session?.userId
  )
    return next();

  const companyId = Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
  const ledgerId = Number(req.body?.paymentAccountId);
  if (!companyId || !Number.isSafeInteger(ledgerId) || ledgerId < 1) return next();

  try {
    const check = await db.execute(sql`
      SELECT to_regclass('factory_fx_agent_wallets')::text AS wallet_table
    `);
    if (!check.rows[0]?.wallet_table) return next();
    const match = await db.execute(sql`
      SELECT id FROM factory_fx_agent_wallets
      WHERE company_id = ${companyId} AND ledger_account_id = ${ledgerId}
      LIMIT 1
    `);
    if (match.rows.length && req.body?.optional === true && req.body?.fxWalletDraft === true) {
      // FX EUR Optional payments are planning documents only. No native wallet
      // movement may occur until the dedicated settlement/finalize transaction.
      const beneficiary = Array.isArray(req.body.entries) && req.body.entries.length === 1 ? req.body.entries[0] : null;
      const amount = String(beneficiary?.amount ?? "");
      const rate = String(req.body?.exchangeRate ?? "");
      if (
        !["Admin", "Owner", "Developer"].includes(String(req.session.currentRole)) ||
        req.body?.currency !== "EUR" ||
        beneficiary?.accountType !== "factorySupplier" ||
        !Number.isSafeInteger(Number(beneficiary?.accountId)) ||
        Number(beneficiary.accountId) <= 0 ||
        !/^\d+(?:\.\d{1,2})?$/.test(amount) ||
        Number(amount) <= 0 ||
        !/^\d+(?:\.\d{1,10})?$/.test(rate) ||
        Number(rate) <= 0
      ) {
        return res.status(400).json({
          code: "FX_WALLET_DRAFT_INVALID",
          message: "Optional FX wallet drafts require a valid direct EUR supplier payment and wallet book rate.",
        });
      }
      const supplier = await db.execute(sql`
        SELECT id FROM factory_suppliers
        WHERE company_id = ${companyId} AND id = ${Number(beneficiary.accountId)} AND is_active = true
        LIMIT 1
      `);
      if (!supplier.rows.length) {
        return res.status(400).json({ message: "Select an active factory supplier in this company" });
      }
      return next();
    }
    if (match.rows.length) {
      return res.status(409).json({
        code: "FX_WALLET_PAYMENT_REQUIRED",
        message:
          "This Pay From account holds FX wallet funds. Use its EUR balance and agreed payout rate in Factory Payment Voucher instead of posting the historical USD ledger directly.",
      });
    }
    return next();
  } catch (error) {
    return res.status(500).json({ message: getErrorMessage(error) });
  }
}

type DraftEditBody = {
  optional?: unknown;
  paymentAccountType?: unknown;
  paymentAccountId?: unknown;
  entries?: unknown;
  currency?: unknown;
  exchangeRate?: unknown;
};

/** An Optional EUR wallet draft stays one EUR supplier line at its stored wallet book rate. */
function normalizeDraftEdit(body: DraftEditBody, draft: FxWalletDraft): string | null {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const line =
    entries.length === 1 ? (entries[0] as { accountType?: unknown; accountId?: unknown; amount?: unknown }) : null;
  if (draft.currency !== "EUR" || !draft.exchangeRate || Number(draft.exchangeRate) <= 0) {
    return "This Optional FX wallet voucher is not a EUR draft. Delete it and enter the payment again.";
  }
  if (body.paymentAccountType !== "ledger" || Number(body.paymentAccountId) !== draft.walletLedgerId) {
    return "An Optional EUR FX payment must keep its FX agent wallet as Pay From.";
  }
  if (
    !line ||
    line.accountType !== "factorySupplier" ||
    !Number.isSafeInteger(Number(line.accountId)) ||
    Number(line.accountId) <= 0 ||
    !/^\d+(?:\.\d{1,2})?$/.test(String(line.amount ?? "")) ||
    Number(line.amount) <= 0
  ) {
    return "An Optional EUR FX payment needs exactly one factory supplier and a positive EUR amount.";
  }
  body.currency = "EUR";
  body.exchangeRate = draft.exchangeRate;
  return null;
}

/**
 * Optional on/off for FX agent wallet payments on the voucher PATCH routes.
 *
 * - Optional EUR draft -> OFF: runs the atomic wallet settlement (never an
 *   ordinary ledger Payment), after saving any edit made in the same request.
 * - Posted direct EUR payment -> ON: cancels the settlement and keeps an
 *   equivalent Optional draft.
 * - Edits of a draft that stays Optional are kept in EUR at its stored rate.
 * This also covers legacy PATCH editors which default omitted optional=false.
 */
export async function guardFxWalletDraftMutation(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "PATCH") return next();
  const cid = Number(req.session?.factoryCompanyId || req.session?.currentCompanyId || 0);
  const id = Number(req.params.id);
  if (!cid || !Number.isSafeInteger(id) || id < 1) return next();
  const route = req.baseUrl.endsWith("/optional")
    ? "optional"
    : req.baseUrl.endsWith("/payment-receipt")
      ? "payment-receipt"
      : "other";
  const wantsOptional = req.body?.optional === true;
  try {
    const draft = await loadFxWalletDraft(cid, id);
    if (draft) {
      if (route === "payment-receipt") {
        if (!FX_DRAFT_ROLES.includes(String(req.session.currentRole))) {
          return res.status(403).json({ message: "Only Admin and Owner can change FX wallet payments" });
        }
        const problem = normalizeDraftEdit(req.body ?? {}, draft);
        if (problem) return res.status(400).json({ code: "FX_WALLET_DRAFT_INVALID", message: problem });
        if (wantsOptional) return next();
        // Save the edit as a draft first, then settle it. If the settlement is
        // refused the edited draft stays Optional and the reason is returned.
        req.body.optional = true;
        const sendJson = res.json.bind(res);
        res.json = ((payload: unknown) => {
          res.json = sendJson;
          if (res.statusCode >= 400) return sendJson(payload);
          void finalizeFxWalletDraft(req, res, () => sendJson(payload));
          return res;
        }) as typeof res.json;
        return next();
      }
      if (wantsOptional) return next();
      if (route === "optional") {
        return finalizeFxWalletDraft(req, res, () =>
          res.status(409).json({ message: "Optional FX voucher changed. Reload and try again." })
        );
      }
      return res.status(409).json({
        code: "FX_WALLET_DRAFT_REQUIRES_SETTLEMENT",
        message:
          "This Optional EUR FX voucher must be finalized through the FX settlement workflow, not activated as a regular ledger Payment.",
      });
    }
    if (!wantsOptional || route === "other") return next();
    // A posted direct EUR wallet payment switched to Optional.
    const draftId = await revertFxEurPaymentToDraft(req, id);
    if (draftId === null) return next();
    if (route === "payment-receipt") {
      const reverted = await loadFxWalletDraft(cid, draftId);
      const problem = reverted ? normalizeDraftEdit(req.body ?? {}, reverted) : "Optional FX draft is unavailable";
      const plan = problem
        ? null
        : paymentReceiptEditPlan(
            { currency: "EUR", exchangeRate: reverted!.exchangeRate, voucherDate: req.body.voucherDate },
            req.body
          );
      if (!plan) {
        return res.status(400).json({
          code: "FX_WALLET_DRAFT_INVALID",
          message: `The payment is now Optional and its EUR was restored, but the other changes were not saved: ${problem || "Invalid amount"}`,
          voucherId: draftId,
        });
      }
      const edited = await db.transaction((tx) =>
        applyPaymentReceiptEditTx(tx, {
          companyId: cid,
          voucherId: draftId,
          body: req.body,
          plan,
          actor: { userId: req.session.userId, username: req.session.username },
        })
      );
      return res.json({ voucher: edited.voucher, entries: edited.entries, replacedVoucherId: id });
    }
    return res.json({ id: draftId, optional: true, replacedVoucherId: id });
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    return res.status(status >= 400 && status < 500 ? status : 500).json({ message: getErrorMessage(error) });
  }
}
