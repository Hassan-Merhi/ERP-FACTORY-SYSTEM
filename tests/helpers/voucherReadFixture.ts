/**
 * Small voucher fixtures for the rolled-back factory world (see
 * rolledBackFactoryApp): a voucher header, ledger accounts, voucher lines and
 * stock items, all written on the world's transaction.
 */
import type { FactoryWorld } from "./rolledBackFactoryApp";

let seq = 0;
export const nextSeq = () => ++seq;

export async function voucher(
  w: FactoryWorld,
  type: string,
  fields: { locationId?: number | null; companyId?: number; date?: string; total?: string } = {}
) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      fields.companyId ?? w.companyId,
      `${w.tag}-V${nextSeq()}`,
      type,
      fields.date ?? "2026-05-01",
      fields.total ?? "100",
      fields.locationId ?? null,
    ]
  );
}

export function ledger(w: FactoryWorld, name = "Cash", accountType = "Cash") {
  const n = nextSeq();
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}-LA${n}`, `${name} ${n}`, accountType]
  );
}

export async function line(
  w: FactoryWorld,
  voucherId: number,
  target: Record<string, number>,
  debit = "0",
  credit = "0"
) {
  const cols = Object.keys(target);
  return w.one(
    `INSERT INTO voucher_entries (voucher_id, ${cols.join(", ")}, debit_amount, credit_amount, narration)
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}, $${cols.length + 2}, $${cols.length + 3}, 'line')
     RETURNING id`,
    [voucherId, ...cols.map((c) => target[c]), debit, credit]
  );
}

export const item = (w: FactoryWorld, name: string, sellingPrice: string | null = "30") =>
  w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, selling_price) VALUES ($1, $2, $3, 'PCS', $4) RETURNING id`,
    [w.companyId, `${w.tag}-I${nextSeq()}`, name, sellingPrice]
  );

export const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}X${nextSeq()}`.slice(0, 20),
  ]);

export const view = (w: FactoryWorld, id: number | string, agent = w.agent) =>
  agent.get(`/api/vouchers/${id}/view-entries`);
