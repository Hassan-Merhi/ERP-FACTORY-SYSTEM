/**
 * Voucher fixtures shared by the ledger guard suites.
 */
import type { PoolClient } from "pg";

import { seedRow } from "./dbGuardHarness";

type Row = Record<string, unknown>;

let voucherSequence = 0;

/** A posted, non-optional USD voucher in an open period, with no lines. */
export async function seedVoucher(client: PoolClient, values: Row = {}): Promise<Row> {
  voucherSequence += 1;
  return seedRow(client, "vouchers", {
    voucher_number: `GUARD-V-${process.pid}-${voucherSequence}`,
    voucher_type: "Journal",
    voucher_date: "2026-03-10",
    effective_date: "2026-03-10",
    currency: "USD",
    exchange_rate: "1",
    optional: false,
    posted_by_engine: false,
    balance_guard_exempt_history: false,
    ...values,
  });
}

export async function seedLedger(client: PoolClient, companyId: unknown, values: Row = {}): Promise<Row> {
  return seedRow(client, "ledger_accounts", { company_id: companyId, account_type: "Asset", ...values });
}

/** Adds a line the way an application would: every trigger runs. */
export async function addLine(client: PoolClient, voucher: Row, values: Row): Promise<Row> {
  const row: Row = { voucher_id: voucher.id, ...values };
  const names = Object.keys(row);
  const { rows } = await client.query(
    `INSERT INTO voucher_entries (${names.map((name) => `"${name}"`).join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`,
    names.map((name) => row[name])
  );
  return rows[0];
}
