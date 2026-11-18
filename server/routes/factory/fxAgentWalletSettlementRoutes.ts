import type { Express, Request, Response, NextFunction } from "express";
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
import { loadFxAgentEurSupplierPayable } from "../../services/factory/fxAgentEurSupplierPayable";

/**
 * Payment out of an agent's EUR balance to a EUR factory supplier, or to a USD beneficiary.
 * The agent's historical USD book basis (not the Settings rate) is credited;
 * the difference from the actual USD payout is a realized FX gain or loss.
 */
export function registerFactoryFxAgentSettlementRoutes(app: Express) {
  const settleWalletPayment = async (req: Request, res: Response) => {
      try {
        const cid = Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
        const walletId = Number(req.params.id),
          targetId = Number(req.body?.targetId);
        const paymentVoucher = req.body?.paymentVoucher === true;
        const targetCurrency = String(req.body?.targetCurrency || "USD").toUpperCase();
        const directEurPayment = paymentVoucher && targetCurrency === "EUR";
        const enteredEur = String(req.body?.eurAmount || "");
        const usdAmount = String(req.body?.usdAmount || "");
        const fx = String(req.body?.rateUsdPerEur || "");
        const key = String(req.body?.requestKey || "");
        const date = String(req.body?.date || getClientDate(req));
        const targetKind = String(req.body?.targetKind || "");
        const narration = String(req.body?.narration || "").slice(0, 500);
        const sourceNarration = String(req.body?.paymentAccountNarration || "").slice(0, 500);
        const beneficiaryNarration = String(req.body?.beneficiaryNarration || "").slice(0, 500);
        const draftVoucherId = req.body?.draftVoucherId === undefined ? null : Number(req.body.draftVoucherId);
        if (
          !cid ||
          (draftVoucherId !== null && (!Number.isSafeInteger(draftVoucherId) || draftVoucherId < 1)) ||
          (draftVoucherId !== null && (!paymentVoucher || !directEurPayment)) ||
          !Number.isSafeInteger(walletId) ||
          walletId < 1 ||
          !Number.isSafeInteger(targetId) ||
          targetId < 1 ||
          !/^[A-Za-z0-9._:-]{8,100}$/.test(key) ||
          !["EUR", "USD"].includes(targetCurrency) ||
          (!paymentVoucher && (targetCurrency !== "USD" || !/^\d+(?:\.\d{1,6})?$/.test(enteredEur))) ||
          (directEurPayment && (!/^\d+(?:\.\d{1,2})?$/.test(enteredEur) || toMoney(enteredEur).lte(0) || targetKind !== "factorySupplier")) ||
          (paymentVoucher && !directEurPayment && (!/^\d+(?:\.\d{1,2})?$/.test(usdAmount) || toMoney(usdAmount).lte(0))) ||
          (!directEurPayment && (!/^\d+(?:\.\d{1,10})?$/.test(fx) || toMoney(fx).lte(0))) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          date > getClientDate(req) ||
          !["factorySupplier", "ledger"].includes(targetKind)
        ) {
          return res.status(400).json({ message: "Invalid FX settlement parameters" });
        }
        // Native EUR supplier payments are already EUR: never translate the
        // entered amount to USD or require a new negotiated payout rate.
        const eur = directEurPayment
          ? enteredEur
          : paymentVoucher
            ? toMoney(usdAmount).div(toMoney(fx)).toDecimalPlaces(6).toFixed(6)
            : enteredEur;
        if (toMoney(eur).lte(0)) throw new Error("EUR payment amount is too small");
        const result = await db.transaction(async (tx) => {
          const locked = await tx.execute(sql`
          SELECT id, ledger_account_id AS "ledgerId" FROM factory_fx_agent_wallets
          WHERE id = ${walletId} AND company_id = ${cid} FOR UPDATE`);
          if (!locked.rows.length) throw new Error("FX agent wallet not found");
          if (draftVoucherId !== null) {
            // Verify the source, beneficiary, amount, currency, date and line count
            // under locks. A generic Optional voucher may NEVER be silently
            // converted into an FX settlement or settle somebody else's wallet.
            const draft = await tx.execute(sql`
              SELECT id, optional, currency, voucher_type AS "voucherType",
                to_char(voucher_date, 'YYYY-MM-DD') AS date
              FROM vouchers
              WHERE id = ${draftVoucherId} AND company_id = ${cid}
                AND deleted_at IS NULL
              FOR UPDATE
            `);
            const header = draft.rows[0];
            if (
              !header || header.optional !== true || header.currency !== "EUR" ||
              header.voucherType !== "Payment" || header.date !== date
            ) throw new Error("Optional EUR FX payment draft is no longer eligible to finalize");
            const draftLines = await tx.execute(sql`
              SELECT ledger_account_id AS "ledgerId", factory_supplier_id AS "supplierId",
                transaction_currency AS currency,
                transaction_debit_amount::text AS debit,
                transaction_credit_amount::text AS credit
              FROM voucher_entries WHERE voucher_id = ${draftVoucherId}
              ORDER BY id FOR UPDATE
            `);
            if (
              draftLines.rows.length !== 2 ||
              !draftLines.rows.some((line) =>
                Number(line.ledgerId) === Number(locked.rows[0].ledgerId) &&
                line.currency === "EUR" && toMoney(String(line.credit)).eq(eur) &&
                toMoney(String(line.debit)).isZero()
              ) ||
              !draftLines.rows.some((line) =>
                Number(line.supplierId) === targetId && line.currency === "EUR" &&
                toMoney(String(line.debit)).eq(eur) &&
                toMoney(String(line.credit)).isZero()
              )
            ) throw new Error("Optional FX draft entries no longer match its EUR wallet settlement");
          }
          const prior = await tx.execute(sql`
          SELECT op.id, op.kind, op.wallet_id AS "walletId", op.source_amount::text AS amount,
            op.rate_usd_per_eur::text AS rate, op.target_kind AS "targetKind",
            op.target_currency AS "targetCurrency", op.target_amount::text AS "targetAmount",
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
              p.targetCurrency !== targetCurrency ||
              (directEurPayment
                ? !toMoney(String(p.targetAmount)).eq(eur)
                : !toMoney(String(p.rate)).eq(fx)) ||
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
          SELECT id, name,
            ${targetKind === "factorySupplier" ? sql`is_broker AS "isBroker"` : sql`false AS "isBroker"`}
          FROM ${destinationTable}
          WHERE company_id = ${cid} AND id = ${targetId} ${destinationExtra}
          ${directEurPayment ? sql`FOR UPDATE` : sql``}`);
          if (!targetRows.rows.length) throw new Error("Beneficiary is not active in this company");
          if (directEurPayment) {
            const payable = await loadFxAgentEurSupplierPayable(
              tx,
              cid,
              { id: targetId, isBroker: targetRows.rows[0].isBroker === true },
              true
            );
            if (!payable.eligible) {
              throw new Error(
                payable.basis === "broker-statement"
                  ? "This broker has no positive EUR settlement balance in Parties"
                  : "This supplier has no confirmed native EUR payable to settle"
              );
            }
            if (toMoney(eur).gt(payable.balance)) {
              throw new Error(
                `EUR payment exceeds the ${payable.basis === "broker-statement" ? "broker settlement" : "supplier"} EUR balance (${payable.balance})`
              );
            }
          }
          // A EUR-to-EUR transfer uses the agent's remaining historical book
          // value on BOTH lines. Its nominal 1:1 preview is solely used to
          // apportion that book value; it is not a new FX conversion.
          const quote = settlementPreview(eur, directEurPayment ? "1" : fx, snapshot.state);
          if (paymentVoucher && !directEurPayment && !toMoney(quote.usd).eq(usdAmount)) {
            throw new Error("USD amount cannot be paid precisely at this rate. Adjust the USD amount or rate");
          }
          const bookRate = toMoney(quote.bookUsd).div(quote.eur).toDecimalPlaces(10);
          if (bookRate.lte(0)) throw new Error("Agent EUR historical book value is unavailable");
          const postedBook = toMoney(quote.eur).times(bookRate).toDecimalPlaces(6);
          const gain = directEurPayment ? toMoney(0) : toMoney(quote.usd).minus(postedBook);
          const lines: FactoryVoucherLine[] = [
            {
              ...(targetKind === "ledger" ? { ledgerAccountId: targetId } : { factorySupplierId: targetId }),
              currency: directEurPayment ? "EUR" : "USD",
              ...(directEurPayment ? { fxRateToUsd: bookRate.toFixed(10) } : {}),
              debit: directEurPayment ? quote.eur : quote.usd,
              narration: beneficiaryNarration || (paymentVoucher && narration) ||
                (directEurPayment ? "EUR payment from FX agent" : "USD payment from FX agent"),
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
            currency: directEurPayment ? "EUR" : "USD",
            ...(directEurPayment ? { fxRateToUsd: bookRate.toFixed(10) } : {}),
            source: { sourceType: "factory-fx-agent-settlement", sourceId: key },
            description: directEurPayment
              ? `FX agent direct EUR payment: EUR ${quote.eur} to ${String(targetRows.rows[0].name)} (no currency exchange)`
              : paymentVoucher
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
          VALUES (${cid},${walletId},${date},'EUR_SETTLEMENT','EUR',${quote.eur},
            ${targetCurrency},${directEurPayment ? quote.eur : quote.usd},
            ${directEurPayment ? bookRate.toFixed(10) : quote.rate},${quote.bookUsd},
            ${gain.toFixed(6)},${targetKind},${targetId},
            ${booked.voucher.id},${key},${narration},
            ${req.session.username || "unknown"})
          RETURNING id`);
          if (draftVoucherId !== null) {
            // Draft is off-ledger. Retire it only after the native EUR settlement
            // and Payment voucher were created, in this very transaction.
            const retired = await tx.execute(sql`
              UPDATE vouchers SET deleted_at = NOW()
              WHERE id = ${draftVoucherId} AND company_id = ${cid}
                AND optional = true AND deleted_at IS NULL
              RETURNING id
            `);
            if (retired.rows.length !== 1) throw new Error("Optional FX draft was changed during settlement");
          }
          return {
            id: Number(inserted.rows[0].id), voucherId: booked.voucher.id,
            quote: directEurPayment
              ? { eur: quote.eur, usd: postedBook.toFixed(6), bookUsd: quote.bookUsd,
                  gainUsd: "0.000000", rate: bookRate.toFixed(10), targetCurrency: "EUR" }
              : { ...quote, targetCurrency: "USD" },
            replayed: booked.replayed,
          };
        });
        res.status(201).json(result);
      } catch (error) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
  };

  app.post(
    "/api/factory/fx-agent-wallets/:id/settle",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    settleWalletPayment
  );

  // The Optional Vouchers screen uses the same finalize URL as other drafts.
  // Recognize only EUR FX wallet drafts; let the ordinary handlers own others.
  app.post(
    "/api/vouchers/:id/finalize",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
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
          JOIN voucher_entries dst ON dst.voucher_id = v.id
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
          !row.supplierId || !/^[0-9]+(?:\.[0-9]+)?$/.test(String(row.recipientEur)) ||
          !toMoney(String(row.recipientEur)).eq(String(row.sourceEur))
        ) return res.status(409).json({ message: "Optional FX draft EUR amounts do not match" });
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
    }
  );
}
