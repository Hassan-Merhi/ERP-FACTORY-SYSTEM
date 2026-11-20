/**
 * As-of monetary FX valuation of one cash ledger or bank account
 * (monetaryAccountValuationTx) in a rolled-back company: verified native
 * openings (debit and credit side), unverified legacy openings, complete
 * foreign-currency lines, legacy USD lines, partially populated foreign lines,
 * missing company rates, linked bank ledgers and the as-of date cut-off.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { monetaryAccountValuationTx } from "../server/services/accounting/monetaryFxValuation";

const value = (world: FactoryWorld, accountKind: "ledger" | "bank", accountId: number, asOfDate = "2026-06-30") =>
  db.transaction((tx) =>
    monetaryAccountValuationTx(tx, { companyId: world.companyId, accountKind, accountId, asOfDate })
  );

async function voucher(world: FactoryWorld, currency: string, date: string) {
  return world.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
     VALUES ($1, $2, 'Receipt', $3, '0', $4::varchar, CASE WHEN $4::varchar = 'USD' THEN NULL ELSE 600 END) RETURNING id`,
    [world.companyId, `${world.tag}-V${Math.floor(Math.random() * 1e9)}`, date, currency]
  );
}

type Line = {
  ledger?: number | null;
  bank?: number | null;
  currency?: string | null;
  native?: [string | null, string | null];
  base?: [string | null, string | null];
  legacy: [string, string];
  /** Insert as a pre-normalisation legacy row (the entry trigger fills the currency columns otherwise). */
  raw?: boolean;
};

async function line(world: FactoryWorld, voucherId: number, l: Line) {
  if (l.raw) await world.q(`SET LOCAL session_replication_role = replica`);
  await world.q(
    `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, bank_account_id, transaction_currency,
       transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount, debit_amount, credit_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      world.companyId,
      voucherId,
      l.ledger ?? null,
      l.bank ?? null,
      l.currency ?? null,
      l.native?.[0] ?? null,
      l.native?.[1] ?? null,
      l.base?.[0] ?? null,
      l.base?.[1] ?? null,
      l.legacy[0],
      l.legacy[1],
    ]
  );
  if (l.raw) await world.q(`SET LOCAL session_replication_role = origin`);
}

describe("monetaryAccountValuationTx", () => {
  it("translates verified foreign and USD buckets of a cash ledger at the dated company rate", () =>
    withFactoryWorld(async (world) => {
      const cash = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active, opening_balance, opening_balance_side,
           opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount)
         VALUES ($1, $2, 'Till', 'Cash', true, '6000', 'Dr', '6000', 'XOF', '10') RETURNING id`,
        [world.companyId, `${world.tag}-CASH`]
      );
      await world.q(
        `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
         VALUES ($1, 'USD', 'CFA', '500', '2026-06-01')`,
        [world.companyId]
      );
      const cfa = await voucher(world, "CFA", "2026-06-10");
      await line(world, cfa, { ledger: cash, currency: "CFA", legacy: ["3000", "0"] });
      const usd = await voucher(world, "USD", "2026-06-11");
      await line(world, usd, { ledger: cash, legacy: ["2", "0"] });
      const later = await voucher(world, "USD", "2026-07-15");
      await line(world, later, { ledger: cash, legacy: ["99", "0"] });

      const report = await value(world, "ledger", cash);
      expect(report).toMatchObject({
        accountKind: "ledger",
        accountId: cash,
        accountName: "Till",
        accountedBase: "USD",
      });
      const cfaBucket = report.buckets.find((b) => b.currency === "CFA");
      expect(cfaBucket).toMatchObject({
        nativeBalance: "9000.000000",
        historicalUsdBasis: "15.000000",
        translatedUsd: "18.000000",
        unrealizedDifferenceUsd: "3.000000",
        verified: true,
      });
      expect(report.buckets.find((b) => b.currency === "USD")).toMatchObject({
        nativeBalance: "2.000000",
        translatedUsd: "2.000000",
        verified: true,
      });
      expect(report.totals).toMatchObject({
        historicalUsd: "17.000000",
        translatedUsd: "20.000000",
        unrealizedDifferenceUsd: "3.000000",
        unresolvedCurrencies: [],
      });
    }));

  it("leaves the totals untranslated when a currency has no rate or a line lacks verified columns", () =>
    withFactoryWorld(async (world) => {
      const cash = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active, opening_balance, opening_balance_side,
           opening_balance_native_amount, opening_balance_currency, opening_balance_base_amount)
         VALUES ($1, $2, 'Float', 'Cash', true, '100', 'Cr', '100', 'ZMW', '5') RETURNING id`,
        [world.companyId, `${world.tag}-FLT`]
      );
      const cfaPartial = await voucher(world, "CFA", "2026-06-10");
      await line(world, cfaPartial, {
        ledger: cash,
        currency: "CFA",
        native: ["10", null],
        legacy: ["1", "0"],
        raw: true,
      });
      const usdHeaderForeignLine = await voucher(world, "USD", "2026-06-12");
      await line(world, usdHeaderForeignLine, { ledger: cash, currency: "ZMW", legacy: ["1", "0"], raw: true });

      const report = await value(world, "ledger", cash);
      expect(report.buckets.find((b) => b.currency === "ZMW")).toMatchObject({
        nativeBalance: "-100.000000",
        historicalUsdBasis: "-5.000000",
        rate: null,
        translatedUsd: null,
        verified: false,
      });
      expect(report.buckets.find((b) => b.currency === "ZMW")?.issues[0]).toMatch(/No company rate for USD\/ZMW/);
      const unresolved = report.buckets.find((b) => b.currency === "UNRESOLVED");
      expect(unresolved?.issues).toHaveLength(2);
      expect(unresolved?.issues[0]).toMatch(/lacks verified currency\/base columns/);
      expect(report.totals).toMatchObject({ translatedUsd: null, unrealizedDifferenceUsd: null });
      expect(report.totals.unresolvedCurrencies.sort()).toEqual(["UNRESOLVED", "ZMW"]);
    }));

  it("combines a bank with its linked ledger and flags a legacy opening without currency", () =>
    withFactoryWorld(async (world) => {
      const linked = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Bank GL', 'Bank', true, '40', 'Dr') RETURNING id`,
        [world.companyId, `${world.tag}-BGL`]
      );
      const bank = await world.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, active, linked_ledger_id)
         VALUES ($1, $2, 'Main', 'Bank', '001', TRUE, $3) RETURNING id`,
        [world.companyId, `${world.tag}-BK`, linked]
      );
      const v = await voucher(world, "USD", "2026-06-05");
      await line(world, v, { bank, currency: "USD", native: ["7", "0"], base: ["7", "0"], legacy: ["7", "0"] });
      await line(world, v, {
        ledger: linked,
        currency: "USD",
        native: ["0", "2"],
        base: ["0", "2"],
        legacy: ["0", "2"],
      });

      const report = await value(world, "bank", bank);
      expect(report.accountKind).toBe("bank");
      expect(report.buckets.find((b) => b.currency === "USD")).toMatchObject({
        nativeBalance: "5.000000",
        verified: true,
      });
      expect(report.buckets.find((b) => b.currency === "UNRESOLVED")?.issues[0]).toMatch(
        new RegExp(`Opening amount on account #${linked} has no verified native currency`)
      );
      expect(report.totals.translatedUsd).toBeNull();
    }));

  it("reports an empty bank without a linked ledger as zero", () =>
    withFactoryWorld(async (world) => {
      const bank = await world.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, active)
         VALUES ($1, $2, 'Spare', 'Bank', '002', TRUE) RETURNING id`,
        [world.companyId, `${world.tag}-BK2`]
      );
      const report = await value(world, "bank", bank);
      expect(report.buckets).toEqual([]);
      expect(report.totals).toMatchObject({ historicalUsd: "0.000000", translatedUsd: "0.000000" });
    }));
});
