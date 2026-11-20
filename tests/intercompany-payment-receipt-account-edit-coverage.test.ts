/**
 * server/routes/vouchers/buildLegacyPaymentReceiptEditTarget.ts against
 * PostgreSQL in one rolled-back transaction per test: the legacy edit target
 * builder and the intercompany Payment/Receipt account-only correction.
 *
 * Pinned: unknown target types and non-positive ids are refused; the
 * correction refuses a missing or deleted voucher, a voucher with no transfer
 * link, every changed header field (type, optional, date, effective date,
 * currency, rate, notes), non-ledger targets, a different amount, malformed
 * lines and non-positive account ids; replacement accounts must be active
 * ledgers of the same company; an unchanged request is a no-op; a cash-side
 * change follows the transfer's nominated account on the correct leg.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  buildLegacyPaymentReceiptEditTarget,
  isActivePaymentReceiptType,
  updateIntercompanyPaymentReceiptAccounts,
} from "../server/routes/vouchers/buildLegacyPaymentReceiptEditTarget";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;

async function world(client: PoolClient, opts: { type?: "Payment" | "Receipt"; leg?: "from" | "to" } = {}) {
  const tag = `IPR${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const id = async (pending: Promise<{ rows: Array<{ id: unknown }> }>) => Number((await pending).rows[0].id);
  const company = await id(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [tag])
  );
  const other = await id(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${tag}B`])
  );
  const ledger = (companyId: number, code: string, type: string, active = true) =>
    id(
      client.query(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active) VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
        [companyId, `${tag}${code}`, type, active]
      )
    );
  const cash = await ledger(company, "CASH", "Cash");
  const cash2 = await ledger(company, "CASH2", "Cash");
  const contra = await ledger(company, "IC", "Asset");
  const contra2 = await ledger(company, "IC2", "Asset");
  const inactive = await ledger(company, "OLD", "Asset", false);
  const foreign = await ledger(other, "FOR", "Asset");
  const type = opts.type ?? "Payment";
  const voucher = await id(
    client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, description)
       VALUES ($1, $2, $3, '2026-06-01', 100, 'Transfer') RETURNING id`,
      [company, `${tag}V`, type]
    )
  );
  // Payment: debit contra, credit cash. Receipt: debit cash, credit contra.
  const [debitAccount, creditAccount] = type === "Payment" ? [contra, cash] : [cash, contra];
  await client.query(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 100, 0), ($1, $3, 0, 100)`,
    [voucher, debitAccount, creditAccount]
  );
  const leg = opts.leg ?? "from";
  const transfer = await id(
    client.query(
      `INSERT INTO inter_company_transfers (from_company_id, to_company_id, from_ledger_account_id, to_ledger_account_id,
         from_voucher_id, to_voucher_id, amount, transfer_date, transfer_type)
       VALUES ($1, $2, $3, $4, $5, $6, 100, '2026-06-01', 'cash') RETURNING id`,
      leg === "from" ? [company, other, cash, foreign, voucher, null] : [other, company, foreign, cash, null, voucher]
    )
  );
  const body = (overrides: Record<string, unknown> = {}) => ({
    voucherType: type,
    voucherDate: "2026-06-01",
    currency: "USD",
    notes: "Transfer",
    paymentAccountType: "ledger",
    paymentAccountId: cash,
    entries: [{ accountType: "ledger", accountId: contra, amount: "100" }],
    ...overrides,
  });
  const update = (overrides: Record<string, unknown> = {}, voucherId = voucher, companyId = company) =>
    updateIntercompanyPaymentReceiptAccounts({
      voucherId,
      companyId,
      userId: null,
      username: "tester",
      body: body(overrides) as never,
    });
  return { client, company, other, cash, cash2, contra, contra2, inactive, foreign, voucher, transfer, update };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { name?: string; code?: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("legacy edit target builder", () => {
  it("maps every supported account type and refuses unknown types and bad ids", () => {
    expect(buildLegacyPaymentReceiptEditTarget("ledger", "7")).toEqual({ ledgerAccountId: 7 });
    expect(buildLegacyPaymentReceiptEditTarget("factorySupplier", 3)).toEqual({ factorySupplierId: 3 });
    expect(buildLegacyPaymentReceiptEditTarget("customer", 9)).toEqual({ customerId: 9 });
    expect(() => buildLegacyPaymentReceiptEditTarget("vendor", 1)).toThrow(/Unsupported Payment\/Receipt account type/);
    for (const bad of [0, -1, 1.5, "abc", null]) {
      expect(() => buildLegacyPaymentReceiptEditTarget("ledger", bad)).toThrow(/positive integer/);
    }
    expect(isActivePaymentReceiptType("Receipt")).toBe(true);
    expect(isActivePaymentReceiptType("Journal")).toBe(false);
  });
});

describe("intercompany account-only correction refusals", () => {
  it("refuses a missing, deleted or unlinked voucher", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      expect((await refusal(w.update({}, 999999999))).code).toBe("VOUCHER_NOT_FOUND");
      expect((await refusal(w.update({}, w.voucher, w.other))).code).toBe("VOUCHER_NOT_FOUND");
      await client.query(`DELETE FROM inter_company_transfers WHERE id = $1`, [w.transfer]);
      expect((await refusal(w.update())).code).toBe("INTERCOMPANY_TRANSFER_CHANGED");
      await client.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [w.voucher]);
      expect((await refusal(w.update())).code).toBe("VOUCHER_NOT_FOUND");
    }));

  it("refuses every changed header field and malformed request line", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const cases: Array<Record<string, unknown>> = [
        { voucherType: "Receipt" },
        { optional: true },
        { voucherDate: "2026-06-02" },
        { effectiveDate: "2026-06-05" },
        { currency: "EUR" },
        { notes: "Changed" },
        { paymentAccountType: "bank" },
        { entries: "none" },
        { entries: [] },
        { entries: [{ accountType: "supplier", accountId: w.contra, amount: "100" }] },
        { entries: [{ accountType: "ledger", accountId: w.contra, amount: "99" }] },
        { entries: [{ accountType: "ledger", accountId: w.contra, amount: "abc" }] },
        { entries: [{ accountType: "ledger", accountId: 0, amount: "100" }] },
        { paymentAccountId: "x" },
      ];
      for (const overrides of cases) {
        const error = await refusal(w.update(overrides));
        expect(error.name, JSON.stringify(overrides)).toBe("IntercompanyTransferLegEditRefused");
      }
    }));

  it("refuses an optional voucher, a non-USD rate change and malformed stored lines", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      await client.query(`UPDATE vouchers SET optional = true WHERE id = $1`, [w.voucher]);
      expect((await refusal(w.update())).name).toBe("IntercompanyTransferLegEditRefused");
      await client.query(`UPDATE vouchers SET optional = false, currency = 'EUR', exchange_rate = 1.1 WHERE id = $1`, [
        w.voucher,
      ]);
      expect((await refusal(w.update({ currency: "eur", exchangeRate: "1.2" }))).name).toBe(
        "IntercompanyTransferLegEditRefused"
      );
      expect((await refusal(w.update({ currency: "EUR" }))).name).toBe("IntercompanyTransferLegEditRefused");
      await client.query(`UPDATE vouchers SET currency = 'USD', exchange_rate = NULL WHERE id = $1`, [w.voucher]);
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 0)`,
        [w.voucher, w.contra2]
      );
      await client.query(`SET LOCAL session_replication_role = origin`);
      expect((await refusal(w.update())).name).toBe("IntercompanyTransferLegEditRefused");
    }));

  it("refuses an inactive or other-company replacement account", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      for (const accountId of [w.inactive, w.foreign, 999999999]) {
        const error = await refusal(w.update({ entries: [{ accountType: "ledger", accountId, amount: "100" }] }));
        expect(error.code).toBe("POSTING_TARGET_INVALID");
      }
    }));
});

describe("intercompany account-only correction", () => {
  it("is a no-op when nothing changes", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      const result = await w.update();
      expect(result.entries).toHaveLength(2);
      expect(result.whatsapp).toEqual({ prompt: false });
    }));

  it("moves the contra and cash lines and the transfer's nominated cash account (from leg)", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client);
      await w.update({
        paymentAccountId: w.cash2,
        entries: [{ accountType: "ledger", accountId: w.contra2, amount: "100" }],
      });
      const lines = await client.query(
        `SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [w.voucher]
      );
      expect(lines.rows.map((r) => r.ledger_account_id)).toEqual([w.contra2, w.cash2]);
      const transfer = await client.query(`SELECT from_ledger_account_id FROM inter_company_transfers WHERE id = $1`, [
        w.transfer,
      ]);
      expect(transfer.rows[0].from_ledger_account_id).toBe(w.cash2);
    }));

  it("updates the destination leg's cash account for a Receipt", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client, { type: "Receipt", leg: "to" });
      await w.update({ paymentAccountId: w.cash2 });
      const transfer = await client.query(`SELECT to_ledger_account_id FROM inter_company_transfers WHERE id = $1`, [
        w.transfer,
      ]);
      expect(transfer.rows[0].to_ledger_account_id).toBe(w.cash2);
    }));

  it("leaves the transfer alone when only the contra line changes", () =>
    withRolledBackPool(async (client) => {
      const w = await world(client, { type: "Receipt", leg: "to" });
      await w.update({ entries: [{ accountType: "ledger", accountId: w.contra2, amount: "100" }] });
      const transfer = await client.query(`SELECT to_ledger_account_id FROM inter_company_transfers WHERE id = $1`, [
        w.transfer,
      ]);
      expect(transfer.rows[0].to_ledger_account_id).toBe(w.cash);
    }));
});
