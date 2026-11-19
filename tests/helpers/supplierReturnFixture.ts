/**
 * An offloaded ERP container line that a supplier return can draw on, seeded
 * in the rolled-back factory world: supplier, container, USD purchase order
 * with a line for the stock item, offload and offload item, and (optionally)
 * the inventory row at the offload location.
 */
import type { FactoryWorld } from "./rolledBackFactoryApp";
import { nextSeq } from "./voucherReadFixture";

export interface ReturnSourceOptions {
  code?: string;
  stockItemId?: number;
  supplierId?: number;
  quantity?: string;
  rate?: string;
  currency?: string;
  containerStatus?: string;
  inventory?: { quantity: string; value: string } | null;
}

export async function returnSource(w: FactoryWorld, options: ReturnSourceOptions = {}) {
  const n = nextSeq();
  const supplierId =
    options.supplierId ??
    (await w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, 's@x.io') RETURNING id`,
      [w.companyId, `${w.tag}-S${n}`, `Supplier ${n}`]
    ));
  const code = options.code ?? `${w.tag}-ART${n}`;
  const stockItemId =
    options.stockItemId ??
    (await w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, 'BL') RETURNING id`, [
      w.companyId,
      code,
      `Article ${n}`,
    ]));
  const containerId = await w.one(
    `INSERT INTO containers (company_id, container_number, supplier_id, import_date, status)
     VALUES ($1, $2, $3, '2026-03-01', $4) RETURNING id`,
    [w.companyId, `${w.tag}-C${n}`, supplierId, options.containerStatus ?? "OFFLOADED"]
  );
  const poId = await w.one(
    `INSERT INTO purchase_orders (company_id, po_number, supplier_id, container_id, currency)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.companyId, `${w.tag}-PO${n}`, supplierId, containerId, options.currency ?? "USD"]
  );
  const quantity = options.quantity ?? "10";
  const rate = options.rate ?? "5";
  await w.q(
    `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
     VALUES ($1, $2, 'line', $3, $4, $3::numeric * $4::numeric)`,
    [poId, stockItemId, quantity, rate]
  );
  const offloadId = await w.one(
    `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale)
     VALUES ($1, $2, $3, 0) RETURNING id`,
    [containerId, w.locationId, quantity]
  );
  const offloadItemId = await w.one(
    `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value)
     VALUES ($1, $2, $3, $4, $3::numeric * $4::numeric) RETURNING id`,
    [offloadId, stockItemId, quantity, rate]
  );
  const inventory =
    options.inventory === undefined ? { quantity, value: String(Number(quantity) * Number(rate)) } : options.inventory;
  if (inventory) {
    await w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::numeric > 0 THEN $5::numeric / $4::numeric ELSE 0 END)
       ON CONFLICT (location_id, stock_item_id) DO NOTHING`,
      [w.companyId, w.locationId, stockItemId, inventory.quantity, inventory.value]
    );
  }
  return { supplierId, stockItemId, code, containerId, offloadId, offloadItemId };
}
