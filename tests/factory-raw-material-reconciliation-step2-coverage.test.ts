import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { getRawMaterialReconciliation } from "../server/services/factory/rawMaterialReconciliation";

let seq = 0;
const firstId = (result: { rows: Array<{ id: unknown }> }) => Number(result.rows[0].id);

async function seed(client: PoolClient) {
  const code = `RMR${process.pid}${++seq}`.slice(0, 18);
  const companyId = await client
    .query(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
      [code]
    )
    .then(firstId);
  const supplier = (name: string) =>
    client
      .query(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, name])
      .then(firstId);
  const euro = await supplier("Euro Supplier");
  const dollar = await supplier("Dollar Supplier");
  const agent = await supplier("Charge Agent");

  const container = (values: {
    supplierId: number | null;
    status?: string;
    currency?: string;
    fx?: number | null;
    confirmed?: boolean;
    kg?: number | null;
    totalKg?: number | null;
    rate?: number;
    freight?: number | null;
    freightCurrency?: string | null;
    deleted?: boolean;
    otherCharges?: number | null;
    otherChargesSupplierId?: number | null;
    otherChargesCurrency?: string | null;
  }) =>
    client
      .query(
        `INSERT INTO factory_containers
         (company_id, container_number, supplier_id, status, currency_code, fx_rate_to_usd, fx_rate_confirmed,
          actual_received_kg, total_kg, rate_per_kg, freight, freight_currency_code, deleted_at,
          other_charges, other_charges_supplier_id, other_charges_currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $13 THEN NOW() END, $14, $15, $16)
       RETURNING id`,
        [
          companyId,
          `${code}-C${++seq}`,
          values.supplierId,
          values.status ?? "RECEIVED",
          values.currency ?? "USD",
          values.fx ?? null,
          values.confirmed ?? false,
          values.kg ?? null,
          values.totalKg ?? null,
          values.rate ?? 0,
          values.freight ?? null,
          values.freightCurrency ?? null,
          values.deleted ?? false,
          values.otherCharges ?? null,
          values.otherChargesSupplierId ?? null,
          values.otherChargesCurrency ?? null,
        ]
      )
      .then(firstId);

  // EUR container without a confirmed rate: gross is unresolved, as is its EUR freight.
  const unresolvedEuro = await container({ supplierId: euro, currency: "EUR", kg: 100, rate: 2, freight: 30 });
  // EUR container with a confirmed rate, plus USD freight and total_kg fallback.
  const resolvedEuro = await container({
    supplierId: euro,
    currency: "EUR",
    fx: 1.1,
    confirmed: true,
    totalKg: 50,
    rate: 2,
    freight: 10,
    freightCurrency: "USD",
  });
  const usd = await container({
    supplierId: dollar,
    kg: 10,
    rate: 3,
    otherCharges: 7,
    otherChargesSupplierId: agent,
    otherChargesCurrency: "TZS",
  });
  // Ignored: no supplier, deleted, not yet payable, zero amount.
  await container({ supplierId: null, kg: 999, rate: 9 });
  await container({ supplierId: dollar, kg: 999, rate: 9, deleted: true });
  await container({ supplierId: dollar, kg: 999, rate: 9, status: "IN_TRANSIT" });
  await container({ supplierId: dollar, kg: 0, rate: 0 });

  await client.query(
    `INSERT INTO factory_offload_additional_charges (company_id, container_id, supplier_id, description, amount, currency_code)
     VALUES ($1, $2, NULL, 'Handling', 5, 'USD'),
            ($1, $3, $4, 'Agent fee', 8, 'KES'),
            ($1, $2, NULL, 'Zero', 0, 'USD')`,
    [companyId, usd, unresolvedEuro, agent]
  );
  await client.query(
    `INSERT INTO factory_container_other_charges (company_id, container_id, description, amount, currency_code)
     VALUES ($1, $2, 'Port', 4, NULL), ($1, $3, 'Storage', 6, 'USD'), ($1, $2, 'Nothing', 0, NULL)`,
    [companyId, unresolvedEuro, resolvedEuro]
  );
  await client.query(
    `INSERT INTO factory_container_commissions (company_id, container_id, person_name, commission_rate, commission_total, currency_code)
     VALUES ($1, $2, 'Broker', 1, 9, 'USD'), ($1, $3, 'Broker', 1, 3, 'EUR'), ($1, $2, 'Broker', 0, 0, 'USD')`,
    [companyId, usd, unresolvedEuro]
  );
  await client.query(
    `INSERT INTO factory_supplier_payments (company_id, supplier_id, amount, amount_usd, currency_code, date)
     VALUES ($1, $2, 20, 22, 'EUR', '2026-01-10'), ($1, $3, 5, 5, 'USD', '2026-01-11')`,
    [companyId, euro, dollar]
  );
  const voucher = (number: string, currency: string, rate: number | null, optional = false) =>
    client
      .query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate, optional)
       VALUES ($1, $2, 'Payment', '2026-01-12', 0, $3, $4, $5) RETURNING id`,
        [companyId, `${code}-${number}`, currency, rate, optional]
      )
      .then(firstId);
  const entry = (voucherId: number, supplierId: number, debit: number) =>
    client.query(
      `INSERT INTO voucher_entries (voucher_id, company_id, factory_supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, 0)`,
      [voucherId, companyId, supplierId, debit]
    );
  await entry(await voucher("V1", "USD", null), dollar, 4);
  await entry(await voucher("V4", "USD", null, true), dollar, 100);
  // A normalized EUR line carries its native amount and stored USD base.
  await client.query(
    `INSERT INTO voucher_entries (voucher_id, company_id, factory_supplier_id, debit_amount, credit_amount,
       transaction_currency, transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
       historical_exchange_rate, rate_convention)
     VALUES ($1, $2, $3, 12.5, 0, 'EUR', 10, 0, 12.5, 0, 0.8, 'TRANSACTION_PER_BASE')`,
    [await voucher("V3", "EUR", 0.8), companyId, euro]
  );
  return { companyId, euro, dollar, agent, unresolvedEuro };
}

describe("raw material reconciliation, supplier gross and payments stage", () => {
  it("accumulates container, charge, commission and payment amounts per supplier and currency", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, euro, dollar, agent, unresolvedEuro } = await seed(client);
      const result = await getRawMaterialReconciliation(companyId);

      const unresolved = result.unresolvedFxRows
        .map((row) => [row.supplierId, row.source, row.currencyCode, row.nativeAmount])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      expect(unresolved).toEqual(
        [
          [euro, "container", "EUR", 200],
          [euro, "container", "EUR", 30],
          [euro, "container_other_charge", "EUR", 4],
          [euro, "commission", "EUR", 3],
          [agent, "offload_charge", "KES", 8],
          [agent, "container_other_charge", "TZS", 7],
        ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      );
      expect(result.unresolvedFxRows.find((row) => row.source === "container" && row.nativeAmount === 200)?.rowId).toBe(
        unresolvedEuro
      );

      const balance = new Map(result.supplierBalanceByCurrency.map((row) => [row.supplierId, row]));
      expect(balance.get(dollar)).toMatchObject({
        grossExposureByCurrency: { USD: 30 + 5 + 9 },
        paymentsByCurrency: { USD: 5 + 4 },
        hasUnresolvedFx: false,
      });
      expect(balance.get(euro)?.grossExposureByCurrency).toEqual({ EUR: 200 + 30 + 100 + 4 + 3, USD: 10 + 6 });
      expect(balance.get(euro)?.paymentsByCurrency).toMatchObject({ EUR: 20 + 10 });
      expect(balance.get(euro)?.hasUnresolvedFx).toBe(true);
      expect(balance.get(agent)?.grossExposureByCurrency).toEqual({ KES: 8, TZS: 7 });
    });
  });

  it("returns empty supplier balances for a company without suppliers", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = Number(
        (
          await client.query(
            `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
            [`RME${process.pid}${++seq}`.slice(0, 18)]
          )
        ).rows[0].id
      );
      const result = await getRawMaterialReconciliation(companyId);
      expect(result.supplierBalanceByCurrency).toEqual([]);
      expect(result.unresolvedFxRows).toEqual([]);
    });
  });
});
