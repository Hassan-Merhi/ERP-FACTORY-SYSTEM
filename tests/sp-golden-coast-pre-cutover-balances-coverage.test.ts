/**
 * Golden Coast Phase 3 cutover helpers (server/routes/sp/canonicalPreCutoverBalances.ts):
 * cash-account parsing, canonical role resolution (missing, ambiguous,
 * inactive), cash-account validation against this company's ledgers and
 * banks, cutover voucher lookups, and pre-cutover balances (opening side
 * plus vouchers dated before the cutover only). Rolled back per test.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import {
  businessDate,
  canonicalPreCutoverBalances,
  existingCutoverVoucherTx,
  existingPositionCarryForwardVoucherTx,
  GoldenCoastPhase3RouteError,
  parseCashAccount,
  resolveRoleAccounts,
  validateCashAccountTx,
} from "../server/routes/sp/canonicalPreCutoverBalances";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastLedgerRow,
} from "../server/services/accounting/getGoldenCoastAccountDefinition";
import { goldenCoastPhase3VoucherNumber } from "../server/services/accounting/goldenCoastPhase3Cutover";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../server/services/accounting/goldenCoastCutoverMarkers";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const ROLES = [
  "fresh_start_equity",
  "hassan_equity",
  "hassan_savings",
  "gc_sales_cash",
  "profit_pending_distribution",
  "stock_otw",
  "stock_in_hand",
  "container_reserve",
] as const;

let seq = 0;

async function goldenCoast(client: PoolClient) {
  const tag = `GCP${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
  const one = async (text: string, params: unknown[]) => Number((await client.query(text, params)).rows[0].id);
  const companyId = await one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [tag]);
  const accounts: GoldenCoastLedgerRow[] = [];
  for (const [index, role] of ROLES.entries()) {
    const definition = getGoldenCoastAccountDefinition(role);
    const id = await one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        companyId,
        `${tag}${index}`,
        role,
        definition.accountType ?? "Asset",
        definition.subType,
        index === 0 ? "50" : "0",
        index === 0 ? "Cr" : "Dr",
      ]
    );
    accounts.push({
      id,
      companyId,
      code: `${tag}${index}`,
      name: role,
      accountType: "Asset",
      subType: definition.subType,
      isHidden: false,
      active: true,
      deletedAt: null,
    });
  }
  return { tag, one, companyId, accounts };
}

describe("parseCashAccount", () => {
  it("accepts a ledger or bank reference and refuses anything else", () => {
    expect(parseCashAccount({ kind: "bank", id: "7", name: "  Main " })).toEqual({ kind: "bank", id: 7, name: "Main" });
    expect(parseCashAccount({ kind: "ledger", id: 3, name: " " })).toEqual({ kind: "ledger", id: 3 });
    for (const bad of [null, [], "x", { kind: "cash", id: 1 }, { kind: "ledger", id: 0 }, { kind: "bank", id: 1.5 }]) {
      expect(() => parseCashAccount(bad)).toThrow(GoldenCoastPhase3RouteError);
    }
    expect(businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resolveRoleAccounts", () => {
  it("maps each canonical role and refuses a missing, inactive or duplicated role with 409", async () => {
    await withRolledBackPool(async (client) => {
      const w = await goldenCoast(client);
      const resolved = resolveRoleAccounts(w.accounts);
      expect(resolved.freshStartEquityAccountId).toBe(w.accounts[0].id);
      expect(resolved.containerReserveAccountId).toBe(w.accounts[7].id);

      const missing = w.accounts.slice(1);
      expect(() => resolveRoleAccounts(missing)).toThrow(/fresh_start_equity is missing/);
      const inactive = w.accounts.map((a, i) => (i === 2 ? { ...a, active: false } : a));
      expect(() => resolveRoleAccounts(inactive)).toThrow(/hassan_savings is missing/);
      const duplicated = [...w.accounts, { ...w.accounts[3], id: w.accounts[3].id + 100000 }];
      try {
        resolveRoleAccounts(duplicated);
        throw new Error("expected refusal");
      } catch (error) {
        expect(error).toMatchObject({ code: "GC_PHASE3_PHASE2_NOT_READY", status: 409 });
        expect((error as Error).message).toMatch(/gc_sales_cash is ambiguous \(2 active accounts/);
      }
    });
  });
});

describe("validateCashAccountTx", () => {
  it("accepts this company's active cash ledger or bank and refuses others", async () => {
    await withRolledBackPool(async (client) => {
      const w = await goldenCoast(client);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const cash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Cash', 'Cash') RETURNING id`,
        [w.companyId, `${w.tag}CASH`]
      );
      const foreignCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Cash', 'Cash') RETURNING id`,
        [other, `${w.tag}FCASH`]
      );
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Bank', 'B', '1') RETURNING id`,
        [w.companyId, `${w.tag}BK`]
      );
      const foreignBank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Bank', 'B', '2') RETURNING id`,
        [other, `${w.tag}FBK`]
      );
      await expect(validateCashAccountTx(db, w.companyId, { kind: "ledger", id: cash })).resolves.toBeUndefined();
      await expect(validateCashAccountTx(db, w.companyId, { kind: "bank", id: bank })).resolves.toBeUndefined();
      await expect(validateCashAccountTx(db, w.companyId, { kind: "ledger", id: foreignCash })).rejects.toThrow(
        /Cash\/Bank ledger/
      );
      await expect(validateCashAccountTx(db, w.companyId, { kind: "ledger", id: w.accounts[1].id })).rejects.toThrow(
        /Cash\/Bank ledger/
      );
      await expect(validateCashAccountTx(db, w.companyId, { kind: "bank", id: foreignBank })).rejects.toThrow(
        /active bank account/
      );
    });
  });
});

describe("cutover vouchers and pre-cutover balances", () => {
  it("finds the cutover and carry-forward vouchers and sums opening plus pre-cutover lines only", async () => {
    await withRolledBackPool(async (client) => {
      const w = await goldenCoast(client);
      expect(await existingCutoverVoucherTx(db, w.companyId)).toBeNull();
      expect(await existingPositionCarryForwardVoucherTx(db, w.companyId)).toBeNull();
      const voucher = (number: string, date: string, deleted = false) =>
        w.one(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
           VALUES ($1, $2, 'Journal', $3, 10, $4) RETURNING id`,
          [w.companyId, number, date, deleted ? new Date() : null]
        );
      const cutover = await voucher(goldenCoastPhase3VoucherNumber(w.companyId), "2026-09-01");
      const carry = await voucher(goldenCoastExistingPositionCarryForwardVoucherNumber(w.companyId), "2026-09-01");
      expect((await existingCutoverVoucherTx(db, w.companyId))?.id).toBe(cutover);
      expect((await existingPositionCarryForwardVoucherTx(db, w.companyId))?.id).toBe(carry);

      const line = (voucherId: number, account: number, debit: string, credit: string) =>
        client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration) VALUES ($1, $2, $3, $4, 'x')`,
          [voucherId, account, debit, credit]
        );
      const early = await voucher(`${w.tag}-E`, "2026-08-15");
      await line(early, w.accounts[3].id, "30", "0");
      await line(early, w.accounts[1].id, "0", "30");
      const deleted = await voucher(`${w.tag}-D`, "2026-08-16", true);
      await line(deleted, w.accounts[3].id, "999", "0");
      const late = await voucher(`${w.tag}-L`, "2026-09-02");
      await line(late, w.accounts[3].id, "70", "0");

      const balances = await canonicalPreCutoverBalances(db, w.companyId, w.accounts);
      const by = Object.fromEntries(balances.map((b) => [b.role, b.debitMinusCreditUsd]));
      expect(by).toMatchObject({
        fresh_start_equity: "-50.00",
        hassan_equity: "-30.00",
        gc_sales_cash: "30.00",
        stock_otw: "0.00",
      });
    });
  });
});
