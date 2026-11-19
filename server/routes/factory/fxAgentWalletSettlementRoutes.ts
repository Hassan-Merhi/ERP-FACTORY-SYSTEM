import type { Express, Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { registerFactoryFxAgentSettlementRoutesPart1 } from "./registerFactoryFxAgentSettlementRoutesPart1";

/**
 * Payment out of an agent's EUR balance to a EUR factory supplier, or to a USD beneficiary.
 * The agent's historical USD book basis (not the Settings rate) is credited;
 * the difference from the actual USD payout is a realized FX gain or loss.
 */
export function registerFactoryFxAgentSettlementRoutes(app: Express) {
  const { settleWalletPayment } = registerFactoryFxAgentSettlementRoutesPart1();

  app.post(
    "/api/factory/fx-agent-wallets/:id/settle",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    settleWalletPayment
  );

  // The Optional Vouchers screen uses the same finalize URL as other drafts.
  // Recognize only EUR FX wallet drafts; let the ordinary handlers own others.
  app.post("/api/vouchers/:id/finalize", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    const cid = Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
    const id = Number(req.params.id);
    if (!cid || !Number.isSafeInteger(id) || id < 1) return next();
    try {
      const walletTable = await db.execute(sql`
          SELECT to_regclass('factory_fx_agent_wallets')::text AS name
        `);
      if (!walletTable.rows[0]?.name) return next();
      const draft = await db.execute(sql`
          SELECT v.id, to_char(v.voucher_date, 'YYYY-MM-DD') AS date,
            v.description, v.currency,
            w.id AS "walletId", src.transaction_credit_amount::text AS "sourceEur",
            dst.factory_supplier_id AS "supplierId",
            dst.transaction_debit_amount::text AS "recipientEur"
          FROM vouchers v
          JOIN voucher_entries src ON src.voucher_id = v.id
            AND src.transaction_credit_amount > 0
          JOIN factory_fx_agent_wallets w ON w.company_id = v.company_id
            AND w.ledger_account_id = src.ledger_account_id
          LEFT JOIN voucher_entries dst ON dst.voucher_id = v.id
            AND dst.transaction_debit_amount > 0 AND dst.factory_supplier_id IS NOT NULL
          WHERE v.id = ${id} AND v.company_id = ${cid}
            AND v.optional = true AND v.deleted_at IS NULL
            AND v.voucher_type = 'Payment' AND v.currency = 'EUR'
          LIMIT 1
        `);
      const row = draft.rows[0];
      if (!row) return next();
      if (!["Admin", "Owner", "Developer"].includes(String(req.session.currentRole))) {
        return res.status(403).json({ message: "Only Admin and Owner can finalize FX wallet payments" });
      }
      if (
        !row.supplierId ||
        !/^[0-9]+(?:\.[0-9]+)?$/.test(String(row.recipientEur)) ||
        !toMoney(String(row.recipientEur)).eq(String(row.sourceEur))
      )
        return res.status(409).json({ message: "Optional FX draft EUR amounts do not match" });
      req.params.id = String(row.walletId);
      req.body = {
        paymentVoucher: true,
        targetCurrency: "EUR",
        eurAmount: toMoney(String(row.recipientEur)).toFixed(2),
        targetKind: "factorySupplier",
        targetId: Number(row.supplierId),
        date: String(row.date),
        requestKey: `fx-optional-${cid}-${id}`,
        narration: String(row.description || ""),
        draftVoucherId: id,
      };
      return settleWalletPayment(req, res);
    } catch (error) {
      return res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
