/**
 * Drives a customer loading through the real truck-dispatch HTTP workflow:
 * loaded bales -> trip -> barcode scans -> End Dispatch -> financial posting.
 * Use inside `withFactoryWorld` so every row is rolled back.
 */
import { expect } from "vitest";

import type { FactoryWorld } from "./rolledBackFactoryApp";

export const dispatchBase = (orderId: number) => `/api/factory/customer-orders/${orderId}/loading-dispatches`;

export interface LoadedBale {
  baleId: number;
  orderBaleId: number;
  reference: string;
}

let baleSeq = 0;

/** A LOADING order with `prices.length` loaded bales (article ART-A, 25 kg, cost 4.00). */
export async function loadingWithBales(w: FactoryWorld, prices: string[], status = "LOADING") {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Truck Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${++baleSeq}`]
  );
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id)
     VALUES ($1, $2, '2026-06-01', $3, $4) RETURNING id`,
    [w.companyId, customerId, status, w.locationId]
  );
  const bales: LoadedBale[] = [];
  for (const price of prices) {
    const reference = `${w.tag}-B${++baleSeq}`;
    const baleId = await w.one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name,
         weight_kg, cost_per_kg, total_cost, status, erp_location_id)
       VALUES ($1, $2, $2, 'ART-A', 'Mixed Rags', 25, 0.16, 4.00, 'RESERVED_FOR_ORDER', $3) RETURNING id`,
      [w.companyId, reference, w.locationId]
    );
    const orderBaleId = await w.one(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
       VALUES ($1, $2, $3, $4, 25, $5, 'ART-A', 'Mixed Rags') RETURNING id`,
      [orderId, baleId, reference, w.locationId, price]
    );
    bales.push({ baleId, orderBaleId, reference });
  }
  return { customerId, orderId, bales };
}

export async function createTrip(w: FactoryWorld, orderId: number): Promise<number> {
  const res = await w.agent.post(dispatchBase(orderId)).send({});
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

export async function scan(w: FactoryWorld, orderId: number, dispatchId: number, reference: string) {
  const res = await w.agent.post(`${dispatchBase(orderId)}/${dispatchId}/scans`).send({ scanCode: reference });
  expect(res.status).toBe(201);
}

/** End Dispatch through close-preview + close (approving discrepancies when needed). */
export async function closeTrip(w: FactoryWorld, orderId: number, dispatchId: number) {
  const url = `${dispatchBase(orderId)}/${dispatchId}`;
  const preview = await w.agent.get(`${url}/close-preview`);
  expect(preview.status).toBe(200);
  const res = await w.agent.post(`${url}/close`).send({
    confirm: true,
    fingerprint: preview.body.fingerprint,
    discrepancyReason: "Approved split shipment for the test",
  });
  expect(res.status).toBe(200);
}

export async function financialPreview(w: FactoryWorld, orderId: number, dispatchId: number) {
  const res = await w.agent.get(`${dispatchBase(orderId)}/${dispatchId}/financial-preview`);
  expect(res.status).toBe(200);
  return res.body as { source: { sourceFingerprint: string; goodsSubtotal: string } | null; chargeFingerprint: string };
}

export function finalizeTrip(w: FactoryWorld, orderId: number, dispatchId: number, body: Record<string, unknown>) {
  return w.agent.post(`${dispatchBase(orderId)}/${dispatchId}/financial-finalize`).send(body);
}

/** Trip with the given loaded bales scanned and closed. */
export async function closedTrip(w: FactoryWorld, orderId: number, references: string[]) {
  const dispatchId = await createTrip(w, orderId);
  for (const reference of references) await scan(w, orderId, dispatchId, reference);
  await closeTrip(w, orderId, dispatchId);
  return dispatchId;
}

/** Closed and financially posted trip; returns the posting response body. */
export async function postedTrip(w: FactoryWorld, orderId: number, references: string[]) {
  const dispatchId = await closedTrip(w, orderId, references);
  const preview = await financialPreview(w, orderId, dispatchId);
  expect(preview.source).not.toBeNull();
  const res = await finalizeTrip(w, orderId, dispatchId, {
    confirm: true,
    sourceFingerprint: preview.source!.sourceFingerprint,
    chargeFingerprint: preview.chargeFingerprint,
  });
  expect(res.status).toBe(200);
  return { dispatchId, posting: res.body, preview };
}

/** Ledger account in this company (for trip charges). */
export function ledger(w: FactoryWorld, code: string, accountType: string) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
     VALUES ($1, $2::varchar, $2::text, $3, '0', TRUE) RETURNING id`,
    [w.companyId, `${w.tag}${code}`, accountType]
  );
}

export async function addCharge(w: FactoryWorld, orderId: number, dispatchId: number, charge: Record<string, unknown>) {
  const preview = await financialPreview(w, orderId, dispatchId);
  const res = await w.agent.post(`${dispatchBase(orderId)}/${dispatchId}/financial-charges`).send({
    charge,
    expectedSourceFingerprint: preview.source?.sourceFingerprint,
    expectedChargeFingerprint: preview.chargeFingerprint,
  });
  return res;
}

/** Close the company's books through `through` (fiscal period closure guard). */
export async function closeBooks(w: FactoryWorld, through: string) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2000-01-01', 0) RETURNING id`,
    [w.companyId, `${w.tag}CLOSE`]
  );
  const retained = await ledger(w, "RE", "Equity");
  await w.q(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, '2000-01-01', $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [w.companyId, through, w.userId, voucherId, retained]
  );
}
