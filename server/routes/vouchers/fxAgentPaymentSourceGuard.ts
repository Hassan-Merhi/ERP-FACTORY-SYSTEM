/**
 * An FX agent's posted USD ledger is the book basis, not spendable USD.
 * Generic Payment creation must use the atomic FX wallet settlement path
 * instead of crediting this ledger as if it were a USD bank account.
 */
import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";

export async function guardFxWalletPaymentSource(req: Request, res: Response, next: NextFunction) {
  if (
    req.method !== "POST" ||
    req.body?.voucherType !== "Payment" ||
    req.body?.paymentAccountType !== "ledger" ||
    !req.session?.userId
  ) return next();

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
      const beneficiary = Array.isArray(req.body.entries) && req.body.entries.length === 1
        ? req.body.entries[0]
        : null;
      const amount = String(beneficiary?.amount ?? "");
      const rate = String(req.body?.exchangeRate ?? "");
      if (
        !["Admin", "Owner", "Developer"].includes(String(req.session.currentRole)) ||
        req.body?.currency !== "EUR" ||
        beneficiary?.accountType !== "factorySupplier" ||
        !Number.isSafeInteger(Number(beneficiary?.accountId)) ||
        Number(beneficiary.accountId) <= 0 ||
        !/^\\d+(?:\\.\\d{1,2})?$/.test(amount) ||
        Number(amount) <= 0 ||
        !/^\\d+(?:\\.\\d{1,10})?$/.test(rate) ||
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
        message: "This Pay From account holds FX wallet funds. Use its EUR balance and agreed payout rate in Factory Payment Voucher instead of posting the historical USD ledger directly.",
      });
    }
    return next();
  } catch (error) {
    return res.status(500).json({ message: getErrorMessage(error) });
  }
}

/**
 * Never turn an unposted FX wallet draft into an ordinary ledger Payment.
 * Only the FX settlement finalize route may move EUR and retire the draft.
 * This also covers legacy PATCH editors which default omitted optional=false.
 */
export async function guardFxWalletDraftMutation(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "PATCH" || req.body?.optional === true) return next();
  const cid = Number(req.session?.factoryCompanyId || req.session?.currentCompanyId || 0);
  const id = Number(req.params.id);
  if (!cid || !Number.isSafeInteger(id) || id < 1) return next();
  try {
    const table = await db.execute(sql`SELECT to_regclass('factory_fx_agent_wallets')::text AS name`);
    if (!table.rows[0]?.name) return next();
    const matched = await db.execute(sql`
      SELECT v.id FROM vouchers v
      JOIN voucher_entries e ON e.voucher_id = v.id
      JOIN factory_fx_agent_wallets w ON w.company_id = v.company_id
        AND w.ledger_account_id = e.ledger_account_id
      WHERE v.id = ${id} AND v.company_id = ${cid}
        AND v.optional = true AND v.deleted_at IS NULL
        AND v.voucher_type = 'Payment'
        AND e.transaction_credit_amount > 0 AND e.transaction_currency = 'EUR'
      LIMIT 1
    `);
    if (matched.rows.length) {
      return res.status(409).json({
        code: "FX_WALLET_DRAFT_REQUIRES_SETTLEMENT",
        message: "This Optional EUR FX voucher must be finalized through the FX settlement workflow, not activated as a regular ledger Payment.",
      });
    }
    return next();
  } catch (error) {
    return res.status(500).json({ message: getErrorMessage(error) });
  }
}
