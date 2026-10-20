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
