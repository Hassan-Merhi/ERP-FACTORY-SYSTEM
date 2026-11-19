/**
 * A Factory customer with a small posted ledger history for the customer
 * statement exports, seeded inside `withFactoryWorld` (rolled back):
 * an invoice journal (INV-GL-{company}-{order}) for an order with a
 * destination and container, a cached row note on that invoice, a receipt,
 * and optionally many small sales so a PDF has to break pages.
 */
import type { FactoryWorld } from "./rolledBackFactoryApp";

let seq = 0;

export interface StatementCustomer {
  customerId: number;
  orderId: number;
}

async function customerLine(
  w: FactoryWorld,
  customerId: number,
  number: string,
  type: string,
  date: string,
  dr: string,
  cr: string,
  narration: string
) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, type, number, date, Number(dr) || Number(cr)]
  );
  await w.q(
    `INSERT INTO voucher_entries (company_id, voucher_id, customer_id, debit_amount, credit_amount, narration)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [w.companyId, voucherId, customerId, dr, cr, narration]
  );
  return voucherId;
}

export async function statementCustomer(
  w: FactoryWorld,
  options: { name?: string; note?: string | null; extraSales?: number; receipt?: string; opening?: string } = {}
): Promise<StatementCustomer> {
  const n = ++seq;
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name, phone, statement_note, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, '+243810000001', $4, $5, 'Dr') RETURNING id`,
    [w.companyId, `${w.tag}C${n}`, options.name ?? "Statement Customer", options.note ?? null, options.opening ?? "0"]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, destination, container_number)
     VALUES ($1, $2, '2026-02-05', 'INVOICED', $3, 'Kinshasa', 'MSCU1234567') RETURNING id`,
    [w.companyId, customerId, w.locationId]
  );
  await customerLine(
    w,
    customerId,
    `INV-GL-${w.companyId}-${orderId}`,
    "Journal",
    "2026-02-05",
    "400.00",
    "0",
    "Invoice for Kinshasa load"
  );
  await w.q(
    `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
       reference_id, description, debit_amount, balance, row_note)
     VALUES ($1, $2, '2026-02-05', 'SALE', 'INVOICE', $3, 'Invoice', 400, 400, 'Delivered in two trucks')`,
    [w.companyId, customerId, orderId]
  );
  await customerLine(
    w,
    customerId,
    `${w.tag}R${n}`,
    "Receipt",
    "2026-03-10",
    "0",
    options.receipt ?? "100.00",
    "Cash received"
  );
  for (let i = 0; i < (options.extraSales ?? 0); i++) {
    await customerLine(w, customerId, `${w.tag}S${n}-${i}`, "Sales", "2026-03-15", "5.00", "0", `Small sale ${i}`);
  }
  return { customerId, orderId };
}
