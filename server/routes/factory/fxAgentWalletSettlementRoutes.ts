import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { ensureSystemAccounts } from "../../services/accounting/systemAccounts";
import {
  postFactoryVoucherTx,
  factorySessionActor,
  type FactoryVoucherLine,
} from "../../services/factory/factoryVoucherPosting";
import { getFxAgentWalletSnapshot, loadFxAgentWallets } from "../../services/factory/fxAgentWalletDb";
import { settlementPreview } from "../../services/factory/fxAgentWalletState";

/**
 * Payment out of an agent's EUR balance to a USD supplier or ledger account.
 * The agent's historical USD book basis (not the Settings rate) is credited;
 * the difference from the actual USD payout is a realized FX gain or loss.
 */
export function registerFactoryFxAgentSettlementRoutes(app: Express) {
  app.post(
    "/api/factory/fx-agent-wallets/:id/settle",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    async (req: Request, res: Response) => {
      try {
        const cid = Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
        const walletId = Number(req.params.id),
          targetId = Number(req.body?.targetId);
        const paymentVoucher = req.body?.paymentVoucher === true;
        const enteredEur = String(req.body?.eurAmount || "");
        const usdAmount = String(req.body?.usdAmount || "");
        const fx = String(req.body?.rateUsdPerEur || "");
        const key = String(req.body?.requestKey || "");
        const date = String(req.body?.date || getClientDate(req));
        const targetKind = String(req.body?.targetKind || "");
        const narration = String(req.body?.narration || "").slice(0, 500);
        const sourceNarration = String(req.body?.paymentAccountNarration || "").slice(0, 500);
        const beneficiaryNarration = String(req.body?.beneficiaryNarration || "").slice(0, 500);
        if (
          !cid ||
          !Number.isSafeInteger(walletId) ||
          walletId < 1 ||
          !Number.isSafeInteger(targetId) ||
          targetId < 1 ||
          !/^[A-Za-z0-9._:-]{8,100}$/.test(key) ||
          (!paymentVoucher && !/^\d+(?:\.\d{1,6})?$/.test(enteredEur)) ||
          (paymentVoucher && (!/^\d+(?:\.\d{1,2})?$/.test(usdAmount) || toMoney(usdAmount).lte(0))) ||
          !/^\d+(?:\.\d{1,10})?$/.test(fx) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          date > getClientDate(req) ||
          !["factorySupplier", "ledger"].includes(targetKind)
        ) {
          return res.status(400).json({ message: "Invalid FX settlement parameters" });
        }
        // In the Payment Voucher form, the entered amount is the USD the
        // recipient receives. Derive EUR server-side at six-place precision.
        const eur = paymentVoucher
          ? toMoney(usdAmount).div(toMoney(fx)).toDecimalPlaces(6).toFixed(6)
          : enteredEur;
        if (toMoney(eur).lte(0)) throw new Error("EUR payment amount is too small");
        const result = await db.transaction(async (tx) => {
          const locked = await tx.execute(sql`
          SELECT id FROM factory_fx_agent_wallets WHERE id = ${walletId} AND company_id = ${cid} FOR UPDATE`);
          if (!locked.rows.length) throw new Error("FX agent wallet not found");
          const prior = await tx.execute(sql`
          SELECT op.id, op.kind, op.wallet_id AS "walletId", op.source_amount::text AS amount,
            op.rate_usd_per_eur::text AS rate, op.target_kind AS "targetKind",
            target_id AS "targetId",op.voucher_id AS "voucherId",
            v.voucher_type AS "voucherType"
          FROM factory_fx_agent_wallet_operations op
          LEFT JOIN vouchers v ON v.id = op.voucher_id
          WHERE op.company_id = ${cid} AND op.request_key = ${key}`);
          if (prior.rows.length) {
            const p = prior.rows[0];
            if (
              p.kind !== "EUR_SETTLEMENT" ||
              Number(p.walletId) !== walletId ||
              !toMoney(String(p.amount)).eq(eur) ||
              !toMoney(String(p.rate)).eq(fx) ||
              p.targetKind !== targetKind ||
              Number(p.targetId) !== targetId ||
              (paymentVoucher ? p.voucherType !== "Payment" : p.voucherType !== "Journal")
            ) {
              throw new Error("Idempotency key already used for another operation");
            }
            return { id: Number(p.id), voucherId: Number(p.voucherId), replayed: true };
          }
          const wallet = (await loadFxAgentWallets(cid, undefined, tx)).find((w) => w.id === walletId);
          if (!wallet || date < wallet.activatedOn) throw new Error("FX wallet not active on this date");
          if (targetKind === "ledger" && wallet.ledgerAccountId === targetId)
            throw new Error("Cannot pay the source account from its own EUR wallet");
          const snapshot = await getFxAgentWalletSnapshot(wallet, getClientDate(req), tx);
          if (!snapshot.synchronized) throw new Error("Ledger changed outside FX wallet. Reconcile before paying");
          if (snapshot.latestOperationDate && date < snapshot.latestOperationDate)
            throw new Error("Cannot backdate before a more recent FX operation");
          let destinationTable = sql`ledger_accounts`;
          let destinationExtra = sql`AND deleted_at IS NULL AND active = true`;
          if (targetKind === "factorySupplier") {
            destinationTable = sql`factory_suppliers`;
            destinationExtra = sql`AND is_active = true`;
          }
          const targetRows = await tx.execute(sql`
          SELECT id, name FROM ${destinationTable}
          WHERE company_id = ${cid} AND id = ${targetId} ${destinationExtra}`);
          if (!targetRows.rows.length) throw new Error("USD beneficiary is not active in this company");
          const quote = settlementPreview(eur, fx, snapshot.state);
          if (paymentVoucher && !toMoney(quote.usd).eq(usdAmount)) {
            throw new Error("USD amount cannot be paid precisely at this rate. Adjust the USD amount or rate");
          }
          const bookRate = toMoney(quote.bookUsd).div(quote.eur).toDecimalPlaces(10);
          const postedBook = toMoney(quote.eur).times(bookRate).toDecimalPlaces(6);
          const gain = toMoney(quote.usd).minus(postedBook);
          const lines: FactoryVoucherLine[] = [
            {
              ...(targetKind === "ledger" ? { ledgerAccountId: targetId } : { factorySupplierId: targetId }),
              currency: "USD",
              debit: quote.usd,
              narration: beneficiaryNarration || (paymentVoucher && narration) || "USD payment from FX agent",
            },
            {
              ledgerAccountId: wallet.ledgerAccountId,
              currency: "EUR",
              fxRateToUsd: bookRate.toFixed(10),
              credit: quote.eur,
              narration: sourceNarration || "Deduct agent EUR at its historical USD book value",
            },
          ];
          if (!gain.isZero()) {
            const status = (await ensureSystemAccounts(tx, cid, ["FX-REVALUATION"]))[0];
            if (!status || !("accountId" in status) || !["ok", "created", "reused_by_name"].includes(status.state))
              throw new Error("FX revaluation account is unavailable");
            lines.push({
              ledgerAccountId: status.accountId,
              currency: "USD",
              ...(gain.gt(0) ? { credit: gain.toFixed(6) } : { debit: gain.abs().toFixed(6) }),
              narration: "Realized FX gain/loss on agent settlement",
            });
          }
          const booked = await postFactoryVoucherTx(tx, {
            companyId: cid,
            voucherType: paymentVoucher ? "Payment" : "Journal",
            voucherDate: date,
            currency: "USD",
            source: { sourceType: "factory-fx-agent-settlement", sourceId: key },
            description: paymentVoucher
              ? `FX agent payment: USD ${quote.usd} to beneficiary using EUR ${quote.eur} at ${quote.rate} USD/EUR`
              : "FX agent EUR settlement to USD beneficiary",
            actor: factorySessionActor(req),
            lines,
          });
          const inserted = await tx.execute(sql`
          INSERT INTO factory_fx_agent_wallet_operations
          (company_id,wallet_id,effective_date,kind,source_currency,source_amount,target_currency,target_amount,
           rate_usd_per_eur,source_book_usd,fx_gain_usd,target_kind,target_id,voucher_id,
           request_key,narration,created_by)
          VALUES (${cid},${walletId},${date},'EUR_SETTLEMENT','EUR',${quote.eur},'USD',${quote.usd},
            ${quote.rate},${quote.bookUsd},${gain.toFixed(6)},${targetKind},${targetId},
            ${booked.voucher.id},${key},${narration},
            ${req.session.username || "unknown"})
          RETURNING id`);
          return { id: Number(inserted.rows[0].id), voucherId: booked.voucher.id, quote, replayed: booked.replayed };
        });
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
