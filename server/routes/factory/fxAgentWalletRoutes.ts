import type { Express, Request, Response } from "express";
import { registerFactoryFxAgentSettlementRoutes } from "./fxAgentWalletSettlementRoutes";
import { registerFactoryFxAgentReversalRoutes } from "./fxAgentWalletReversalRoutes";
import { registerFactoryFxAgentStatementRoutes } from "./fxAgentWalletStatementRoutes";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logAudit } from "../helpers/auditWriteAdapter";
import { toMoney } from "../../lib/money";
import { getPartyBalance } from "../../services/accounting/balances/ledgerBalanceEngine";
import {
  fxAgentTablesExist,
  getFxAgentWalletSnapshot,
  loadFxAgentWallets,
} from "../../services/factory/fxAgentWalletDb";
import { conversionPreview } from "../../services/factory/fxAgentWalletState";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = ["Admin", "Owner", "Developer"] as const;
function company(req: Request) {
  return Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
}
function positive(value: unknown): string {
  const v = String(value ?? "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(v) || toMoney(v).lte(0)) throw new Error("Positive amount required (max 6 decimals)");
  return v;
}
function rate(value: unknown): string {
  const v = String(value ?? "");
  if (!/^\d+(?:\.\d{1,10})?$/.test(v) || toMoney(v).lte(0)) throw new Error("Enter a positive USD-per-EUR rate");
  return v;
}
function dateOf(req: Request): string {
  const date = String(req.body?.date ?? getClientDate(req));
  if (!DATE.test(date) || date > getClientDate(req)) throw new Error("Date must not be in the future");
  return date;
}
async function configRate(cid: number, date: string) {
  const result = await db.execute(sql`
    SELECT rate_to_usd::text AS rate FROM factory_fx_rates
    WHERE company_id = ${cid} AND currency_code = 'EUR' AND source = 'manual'
      AND effective_date <= ${date}::date
    ORDER BY effective_date DESC, id DESC LIMIT 1`);
  return result.rows[0]?.rate ? String(result.rows[0].rate) : null;
}

export function registerFactoryFxAgentWalletRoutes(app: Express) {
  registerFactoryFxAgentSettlementRoutes(app);
  registerFactoryFxAgentReversalRoutes(app);
  registerFactoryFxAgentStatementRoutes(app);
  app.get("/api/factory/fx-agent-wallets", requireAuth, async (req: Request, res: Response) => {
    try {
      const cid = company(req);
      if (!cid) return res.status(400).json({ message: "Select a factory company" });
      if (!(await fxAgentTablesExist())) return res.json({ setupRequired: true, wallets: [], candidates: [] });
      const asOf =
        typeof req.query.asOf === "string" && DATE.test(req.query.asOf) ? req.query.asOf : getClientDate(req);
      const currentRate = await configRate(cid, asOf);
      const wallets = await loadFxAgentWallets(cid, asOf);
      const snapshots = await Promise.all(wallets.map((w) => getFxAgentWalletSnapshot(w, asOf, db, currentRate)));
      const accounts = await db.execute(sql`
        SELECT id, name, code, account_type AS "accountType" FROM ledger_accounts
        WHERE company_id = ${cid} AND deleted_at IS NULL AND active = true
        AND account_type NOT IN ('Income','Indirect Income','Expense','Indirect Expense','Direct Expense','Equity','Profit','Cash','Bank')
        ORDER BY name LIMIT 1200`);
      const supplierChoices = await db.execute(sql`
        SELECT id, name FROM factory_suppliers
        WHERE company_id = ${cid} AND is_active = true ORDER BY name LIMIT 1200`);
      res.json({
        setupRequired: false,
        asOf,
        currentRate,
        wallets: snapshots,
        candidates: accounts.rows,
        factorySuppliers: supplierChoices.rows,
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/fx-agent-wallets", requireAuth, requireRole(...ROLES), async (req: Request, res: Response) => {
    try {
      const cid = company(req),
        accountId = Number(req.body?.ledgerAccountId),
        date = dateOf(req);
      if (!cid || !(await fxAgentTablesExist()))
        return res.status(409).json({ message: "FX wallet SQL migration required" });
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error("Invalid ledger account");
      if (req.body?.confirmUsdSource !== true)
        throw new Error("Confirm this ledger currently represents USD funds held by the FX agent");
      const created = await db.transaction(async (tx) => {
        const accounts = await tx.execute(sql`
          SELECT id, account_type AS type, opening_balance_currency AS "openingCurrency" FROM ledger_accounts
          WHERE company_id = ${cid} AND id = ${accountId} AND deleted_at IS NULL AND active = true
          FOR UPDATE`);
        const account = accounts.rows[0];
        if (
          !account ||
          [
            "Income",
            "Indirect Income",
            "Expense",
            "Indirect Expense",
            "Direct Expense",
            "Equity",
            "Profit",
            "Cash",
            "Bank",
          ].includes(String(account.type))
        )
          throw new Error("Select an active balance-sheet ledger account");
        if (account.openingCurrency && String(account.openingCurrency).toUpperCase() !== "USD")
          throw new Error("Known non-USD opening balance cannot be activated as a USD FX wallet");
        const existing = await tx.execute(sql`
          SELECT id FROM factory_fx_agent_wallets WHERE company_id = ${cid} AND ledger_account_id = ${accountId}`);
        if (existing.rows.length) throw new Error("Account already linked to FX wallet");
        const linked = await tx.execute(sql`
          SELECT 1 FROM customers WHERE company_id = ${cid} AND ledger_account_id = ${accountId} AND deleted_at IS NULL
          UNION ALL SELECT 1 FROM bank_accounts WHERE company_id = ${cid} AND linked_ledger_id = ${accountId}
          LIMIT 1`);
        if (linked.rows.length) throw new Error("A linked customer or bank account cannot be made an FX agent");

        // This workflow starts from a known USD asset. Refuse known non-USD
        // voucher history; it cannot safely be re-denominated as if it were USD.
        const existingForeign = await tx.execute(sql`
          SELECT 1 FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
          WHERE v.company_id = ${cid} AND ve.ledger_account_id = ${accountId}
            AND v.deleted_at IS NULL AND v.optional = false
            AND COALESCE(v.effective_date, v.voucher_date) <= ${date}::date
            AND ve.transaction_currency IS NOT NULL AND UPPER(ve.transaction_currency) <> 'USD'
          LIMIT 1`);
        if (existingForeign.rows.length)
          throw new Error("Existing foreign-currency voucher history needs manual reconciliation before activation");
        const ledger = await getPartyBalance(tx, { kind: "ledger", companyId: cid, id: accountId, asOf: date });
        const book = toMoney(ledger?.historicalBaseClosing || 0);
        if (book.lte(0)) throw new Error("FX agent must hold a positive (debit) USD asset balance");
        const inserted = await tx.execute(sql`
          INSERT INTO factory_fx_agent_wallets(company_id,ledger_account_id,opening_usd,confirmed_native_usd,activated_on,created_by)
          VALUES (${cid},${accountId},${book.toFixed(6)},true,${date},${req.session.username || "unknown"})
          RETURNING id`);
        return { walletId: Number(inserted.rows[0].id), openingUsd: book.toFixed(6) };
      });
      res.status(201).json(created);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
  // An unused wallet is just a snapshot. If the USD ledger changed after
  // activation, explicitly restart its baseline rather than mislabeling the
  // difference as EUR or silently ignoring posted vouchers.
  app.post(
    "/api/factory/fx-agent-wallets/:id/rebaseline",
    requireAuth,
    requireRole(...ROLES),
    async (req: Request, res: Response) => {
      try {
        const cid = company(req);
        const walletId = Number(req.params.id);
        const reason = String(req.body?.reason ?? "").trim();
        const expectedOpeningUsd = String(req.body?.expectedOpeningUsd ?? "");
        const expectedLedgerBookUsd = String(req.body?.expectedLedgerBookUsd ?? "");
        if (
          !cid || !Number.isSafeInteger(walletId) || walletId <= 0 ||
          !reason || reason.length > 500 ||
          !/^\d+(?:\.\d{1,6})?$/.test(expectedOpeningUsd) ||
          !/^\d+(?:\.\d{1,6})?$/.test(expectedLedgerBookUsd) ||
          req.body?.confirmUsdSource !== true
        ) {
          return res.status(400).json({ message: "Confirm the updated USD ledger balance and give a reason (max 500 characters)" });
        }
        const today = getClientDate(req);
        const saved = await db.transaction(async (tx) => {
          // Lock the wallet and its source ledger so two rebaseline requests
          // cannot race; the expected figures protect against a stale screen.
          const found = await tx.execute(sql`
            SELECT w.id, w.opening_usd::text AS "openingUsd",
              w.activated_on::text AS "activatedOn", a.name AS "accountName",
              a.account_type AS "accountType", a.opening_balance_currency AS "openingCurrency"
            FROM factory_fx_agent_wallets w
            JOIN ledger_accounts a ON a.id = w.ledger_account_id
            WHERE w.id = ${walletId} AND w.company_id = ${cid}
              AND a.company_id = ${cid} AND a.active = true AND a.deleted_at IS NULL
            FOR UPDATE OF w, a
          `);
          if (!found.rows.length) throw new Error("FX wallet or active ledger account not found");
          const account = found.rows[0];
          if (String(account.openingCurrency || "USD").toUpperCase() !== "USD") {
            throw new Error("Account opening currency is not USD; manual reconciliation required");
          }
          const movements = await tx.execute(sql`
            SELECT 1 FROM factory_fx_agent_wallet_operations
            WHERE company_id = ${cid} AND wallet_id = ${walletId} LIMIT 1
          `);
          if (movements.rows.length) {
            throw new Error("Wallet already has FX transactions; manual reconciliation is required");
          }
          const foreign = await tx.execute(sql`
            SELECT 1 FROM voucher_entries ve
            JOIN vouchers v ON v.id = ve.voucher_id
            JOIN factory_fx_agent_wallets w ON w.id = ${walletId} AND w.company_id = ${cid}
            WHERE v.company_id = ${cid} AND ve.ledger_account_id = w.ledger_account_id
              AND v.deleted_at IS NULL AND v.optional = false
              AND COALESCE(v.effective_date, v.voucher_date) <= ${today}::date
              AND ve.transaction_currency IS NOT NULL
              AND UPPER(ve.transaction_currency) <> 'USD'
            LIMIT 1
          `);
          if (foreign.rows.length) {
            throw new Error("Non-USD voucher history exists; review the account manually");
          }
          const accountIdRow = await tx.execute(sql`
            SELECT ledger_account_id AS id FROM factory_fx_agent_wallets
            WHERE id = ${walletId} AND company_id = ${cid}
          `);
          const accountId = Number(accountIdRow.rows[0].id);
          const ledger = await getPartyBalance(tx, { kind: "ledger", companyId: cid, id: accountId, asOf: today });
          if (!ledger) throw new Error("FX agent ledger account is missing");
          const current = toMoney(ledger.historicalBaseClosing);
          const previous = toMoney(String(account.openingUsd));
          if (!previous.eq(expectedOpeningUsd) || !current.eq(expectedLedgerBookUsd)) {
            throw new Error("Account or wallet balance changed. Reload before confirming the adjustment");
          }
          if (current.lte(0)) throw new Error("USD ledger balance must be positive to restart the wallet");
          if (current.minus(previous).abs().lte("0.01")) {
            throw new Error("FX wallet already matches the USD ledger");
          }
          await tx.execute(sql`
            UPDATE factory_fx_agent_wallets
            SET opening_usd = ${current.toFixed(6)}, activated_on = ${today}::date
            WHERE id = ${walletId} AND company_id = ${cid}
          `);
          await logAudit({
            userId: String(req.session.userId || "unknown"),
            username: req.session.username || "unknown",
            companyId: cid,
            action: "repair",
            tableName: "factory_fx_agent_wallets",
            recordId: walletId,
            recordIdentifier: String(account.accountName),
            changes: {
              opening_usd: { old: previous.toFixed(6), new: current.toFixed(6) },
              activated_on: { old: String(account.activatedOn).slice(0, 10), new: today },
              reason: { old: null, new: reason },
            },
          }, tx);
          return { walletId, openingUsd: current.toFixed(6), activatedOn: today };
        });
        return res.json(saved);
      } catch (error) {
        return res.status(409).json({ message: getErrorMessage(error) });
      }
    }
  );
  app.post(
    "/api/factory/fx-agent-wallets/:id/convert",
    requireAuth,
    requireRole(...ROLES),
    async (req: Request, res: Response) => {
      try {
        const cid = company(req),
          walletId = Number(req.params.id);
        const usd = positive(req.body?.usdAmount),
          fx = rate(req.body?.rateUsdPerEur),
          date = dateOf(req);
        const key = String(req.body?.requestKey || "");
        if (!cid || !Number.isSafeInteger(walletId) || walletId <= 0 || !/^[A-Za-z0-9._:-]{8,100}$/.test(key))
          throw new Error("Invalid company, wallet or idempotency key");
        const saved = await db.transaction(async (tx) => {
          const locked = await tx.execute(sql`
          SELECT id FROM factory_fx_agent_wallets WHERE company_id = ${cid} AND id = ${walletId} FOR UPDATE`);
          if (!locked.rows.length) throw new Error("FX agent wallet not found");
          const already = await tx.execute(sql`
          SELECT id, wallet_id AS "walletId", source_amount::text AS usd,
                 rate_usd_per_eur::text AS rate, kind
          FROM factory_fx_agent_wallet_operations WHERE company_id = ${cid} AND request_key = ${key}`);
          if (already.rows.length) {
            const row = already.rows[0];
            if (
              Number(row.walletId) !== walletId ||
              row.kind !== "USD_TO_EUR" ||
              !toMoney(String(row.usd)).eq(usd) ||
              !toMoney(String(row.rate)).eq(fx)
            )
              throw new Error("This request key already belongs to a different conversion");
            return { id: Number(row.id), replayed: true };
          }
          const wallet = (await loadFxAgentWallets(cid, undefined, tx)).find((w) => w.id === walletId);
          if (!wallet || date < wallet.activatedOn) throw new Error("FX wallet inactive on selected date");
          const snapshot = await getFxAgentWalletSnapshot(wallet, getClientDate(req), tx);
          if (!snapshot.synchronized)
            throw new Error("Manual ledger changes detected; reconcile the FX agent before conversion");
          if (snapshot.latestOperationDate && date < snapshot.latestOperationDate)
            throw new Error("Cannot insert conversion before a later FX operation");
          const conversion = conversionPreview(usd, fx);
          if (toMoney(conversion.usd).gt(snapshot.state.usd)) throw new Error("Insufficient USD in FX wallet");
          const inserted = await tx.execute(sql`
          INSERT INTO factory_fx_agent_wallet_operations
          (company_id,wallet_id,effective_date,kind,source_currency,source_amount,
           target_currency,target_amount,rate_usd_per_eur,source_book_usd,request_key,narration,created_by)
          VALUES (${cid},${walletId},${date},'USD_TO_EUR','USD',${conversion.usd},
            'EUR',${conversion.eur},${conversion.rate},${conversion.usd},${key},
            ${String(req.body?.narration || "").slice(0, 500)},${req.session.username || "unknown"})
          RETURNING id`);
          return { id: Number(inserted.rows[0].id), conversion, replayed: false };
        });
        res.status(201).json(saved);
      } catch (error) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
