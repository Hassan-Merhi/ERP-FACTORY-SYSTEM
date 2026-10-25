/**
 * A disposable company for historical sales cost repair dry runs. Everything is
 * written on one pool client inside a transaction that the caller rolls back,
 * so a scenario leaves nothing behind and never sees another test's rows.
 */
import type { PoolClient } from "pg";

import { pool } from "../../server/db";
import { ensureHistoricalSalesCostRepairSchema } from "../../server/services/inventory/ensureHistoricalSalesCostRepairSchema";
import { dryRunCompany } from "../../server/services/inventory/historicalSalesCostRepairDryRun";
import { routePoolToClient } from "./routedPoolClient";

let sequence = 0;

export class HscrFixture {
  private constructor(
    readonly client: PoolClient,
    readonly companyId: number
  ) {}

  static async open(): Promise<HscrFixture> {
    await ensureHistoricalSalesCostRepairSchema(pool);
    const client = await pool.connect();
    await client.query("BEGIN");
    const code = `HSCR${process.pid}${++sequence}`;
    const company = await client.query<{ id: number }>("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [
      code,
      `${code} repair fixture`,
    ]);
    return new HscrFixture(client, Number(company.rows[0].id));
  }

  async close(): Promise<void> {
    try {
      await this.client.query("ROLLBACK");
    } finally {
      this.client.release();
    }
  }

  private async id(sql: string, params: unknown[]): Promise<number> {
    const result = await this.client.query<{ id: number }>(sql, params);
    return Number(result.rows[0].id);
  }

  async location(name = "Main"): Promise<number> {
    return this.id("INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
      this.companyId,
      `L${++sequence}`,
      name,
    ]);
  }

  async item(code = `I${++sequence}`): Promise<number> {
    return this.id(
      "INSERT INTO stock_items(company_id,code,name,uom) VALUES($1,$2::varchar,$2::text,'pcs') RETURNING id",
      [this.companyId, code]
    );
  }

  private async voucher(type: string, at: string, locationId: number | null, extra: Record<string, unknown> = {}) {
    return this.id(
      `INSERT INTO vouchers(company_id,location_id,voucher_number,voucher_type,voucher_date,total_amount,created_at,optional,deleted_at)
       VALUES($1,$2,$3,$4,$5::date,0,$6,$7,$8) RETURNING id`,
      [
        this.companyId,
        locationId,
        `${type.slice(0, 3).toUpperCase()}-${++sequence}`,
        type,
        at.slice(0, 10),
        at,
        extra.optional ?? false,
        extra.deletedAt ?? null,
      ]
    );
  }

  /** A legacy sale line; `cost` is the (possibly wrong) recorded unit cost. */
  async sale(
    at: string,
    locationId: number,
    stockItemId: number,
    quantity: number,
    cost: number,
    price = 15,
    extra: Record<string, unknown> = {}
  ): Promise<{ voucherId: number; salesItemId: number }> {
    const voucherId = await this.voucher("Sales", at, locationId, extra);
    const salesItemId = await this.id(
      `INSERT INTO sales_items(voucher_id,stock_item_id,quantity,selling_price,cost_price,total_sales,total_cost,profit,created_at)
       VALUES($1,$2,$3::numeric,$4::numeric,$5::numeric,$3::numeric*$4::numeric,$3::numeric*$5::numeric,$3::numeric*($4::numeric-$5::numeric),$6) RETURNING id`,
      [voucherId, stockItemId, quantity, price, cost, at]
    );
    return { voucherId, salesItemId };
  }

  async adjustment(
    at: string,
    locationId: number,
    stockItemId: number,
    quantity: number,
    rate: number,
    type = "adjustment"
  ): Promise<number> {
    const voucherId = await this.voucher("Stock Adjustment", at, locationId);
    const adjustmentId = await this.id(
      "INSERT INTO stock_adjustment_vouchers(voucher_id,location_id,adjustment_type,created_at) VALUES($1,$2,$3,$4) RETURNING id",
      [voucherId, locationId, type, at]
    );
    await this.client.query(
      "INSERT INTO stock_adjustment_items(adjustment_id,stock_item_id,quantity,rate,total_amount,created_at) VALUES($1,$2,$3::numeric,$4::numeric,$3::numeric*$4::numeric,$5)",
      [adjustmentId, stockItemId, quantity, rate, at]
    );
    return adjustmentId;
  }

  async transfer(
    at: string,
    fromId: number,
    toId: number,
    stockItemId: number,
    quantity: number,
    rate: number,
    applied = true
  ): Promise<number> {
    const voucherId = await this.voucher("Stock Transfer", at, fromId);
    const transferId = await this.id(
      `INSERT INTO stock_transfer_vouchers(voucher_id,source_location_id,destination_location_id,inventory_applied,created_at)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [voucherId, fromId, toId, applied, at]
    );
    await this.client.query(
      "INSERT INTO stock_transfer_items(transfer_id,stock_item_id,quantity,rate,total_amount,created_at) VALUES($1,$2,$3::numeric,$4::numeric,$3::numeric*$4::numeric,$5)",
      [transferId, stockItemId, quantity, rate, at]
    );
    return transferId;
  }

  async note(
    at: string,
    type: "Credit Note" | "Debit Note",
    locationId: number,
    stockItemId: number,
    quantity: number,
    inventoryCost: number
  ): Promise<number> {
    const voucherId = await this.voucher(type, at, locationId);
    await this.client.query(
      `INSERT INTO credit_note_items(voucher_id,stock_item_id,location_id,quantity,rate,inventory_cost,total_value,created_at)
       VALUES($1,$2,$3,$4::numeric,$5::numeric,$5::numeric,$4::numeric*$5::numeric,$6)`,
      [voucherId, stockItemId, locationId, quantity, inventoryCost, at]
    );
    return voucherId;
  }

  async offload(at: string, locationId: number, stockItemId: number, quantity: number, rate: number, total?: number) {
    const supplierId = await this.id(
      "INSERT INTO suppliers(company_id,code,legal_name,email) VALUES($1,$2::varchar,$2::text,$3) RETURNING id",
      [this.companyId, `S${++sequence}`, `s${sequence}@example.test`]
    );
    const containerId = await this.id(
      "INSERT INTO containers(company_id,container_number,supplier_id,import_date) VALUES($1,$2,$3,$4::date) RETURNING id",
      [this.companyId, `C${++sequence}`, supplierId, at.slice(0, 10)]
    );
    const offloadId = await this.id(
      `INSERT INTO container_offloads(container_id,location_id,total_bales,additional_cost_per_bale,offloaded_at)
       VALUES($1,$2,$3,0,$4) RETURNING id`,
      [containerId, locationId, quantity, at]
    );
    await this.client.query(
      "INSERT INTO container_offload_items(offload_id,stock_item_id,quantity,rate,total_value) VALUES($1,$2,$3,$4,$5)",
      [offloadId, stockItemId, quantity, rate, total ?? quantity * rate]
    );
    return offloadId;
  }

  /** Merge `sourceId` into `keptId` at `at`: the source is deleted and its code kept as an alias. */
  async merge(sourceId: number, keptId: number, at: string): Promise<void> {
    const source = await this.client.query<{ code: string }>(
      "UPDATE stock_items SET deleted_at=$2 WHERE id=$1 RETURNING code",
      [sourceId, at]
    );
    const code = source.rows[0].code;
    await this.client.query(
      "INSERT INTO stock_item_code_aliases(company_id,stock_item_id,alias_code,description,created_at) VALUES($1,$2,$3,$4,$5)",
      [this.companyId, keptId, code, `Merged from: ${code}`, at]
    );
  }

  async opening(stockItemId: number, quantity: number, rate: number | null): Promise<void> {
    await this.client.query("UPDATE stock_items SET opening_qty=$2, opening_rate=$3, opening_value=$4 WHERE id=$1", [
      stockItemId,
      quantity,
      rate,
      rate === null ? null : quantity * rate,
    ]);
  }

  /** The Phase 3 valuation checkpoint: per location/item state at `at`. */
  async checkpoint(
    at: string,
    rows: Array<{ locationId: number; stockItemId: number; quantity: number; rate: number; value?: number }>
  ): Promise<void> {
    await this.client.query(
      "INSERT INTO phase3_inventory_valuation_cutovers(company_id,movement_cutoff_id,created_at) VALUES($1,0,$2)",
      [this.companyId, at]
    );
    for (const row of rows) {
      await this.client.query(
        `INSERT INTO phase3_inventory_valuation_baselines(company_id,stock_item_id,location_id,quantity,average_rate,total_value,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          this.companyId,
          row.stockItemId,
          row.locationId,
          row.quantity,
          row.rate,
          row.value ?? row.quantity * row.rate,
          at,
        ]
      );
    }
  }

  async inventory(locationId: number, stockItemId: number, quantity: number, rate: number): Promise<void> {
    await this.client.query(
      "INSERT INTO inventory(company_id,location_id,stock_item_id,quantity,average_rate,total_value) VALUES($1,$2,$3,$4::numeric,$5::numeric,$4::numeric*$5::numeric)",
      [this.companyId, locationId, stockItemId, quantity, rate]
    );
  }

  async canonical(
    at: string,
    locationId: number,
    stockItemId: number,
    quantityDelta: number,
    unitCost: number,
    sourceType: string,
    sourceId: string,
    idempotencyKey = `${sourceType}:${sourceId}:${++sequence}`,
    reversalOf: number | null = null
  ): Promise<number> {
    return this.id(
      `INSERT INTO canonical_stock_movements
         (company_id,stock_item_id,location_id,quantity_delta,unit_cost,movement_kind,source_type,source_id,idempotency_key,reversal_of_movement_id,occurred_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
      [
        this.companyId,
        stockItemId,
        locationId,
        quantityDelta,
        unitCost,
        quantityDelta < 0 ? "issue" : "receipt",
        sourceType,
        sourceId,
        idempotencyKey,
        reversalOf,
        at,
      ]
    );
  }

  /**
   * Route the shared pool to this fixture's client until the returned function
   * is called, so services that open their own transactions run inside the
   * fixture's: BEGIN/COMMIT/ROLLBACK become savepoints and release is a no-op.
   */
  routePool(): () => void {
    return routePoolToClient(this.client);
  }

  dryRun(cutoff = "2027-01-01T00:00:00Z", options: { diagnoseKeys?: Set<string> } = {}) {
    return dryRunCompany(this.client, this.companyId, new Date(cutoff), options);
  }
}

export async function withHscrFixture<T>(run: (fixture: HscrFixture) => Promise<T>): Promise<T> {
  const fixture = await HscrFixture.open();
  try {
    return await run(fixture);
  } finally {
    await fixture.close();
  }
}
