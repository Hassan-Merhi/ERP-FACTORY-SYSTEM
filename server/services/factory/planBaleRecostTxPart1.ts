// Extracted from ./planBaleRecostTx.ts
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { rows, todayUtc, type MixRow, type RecostUnvalued, type SourceRow } from "./baleRecostTypes";

export async function planBaleRecostTxPart1(tx: DbTransaction, companyId: number) {
  const date = todayUtc();
  const unvalued: RecostUnvalued[] = [];

  const bales = await rows<{
    id: number;
    reference_number: string;
    status: string;
    mix_batch_id: number | null;
    weight_kg: string;
    cost_per_kg: string;
    total_cost: string;
    article_code: string | null;
    production_price: string | null;
    has_product: boolean;
  }>(
    tx,
    sql`
      SELECT b.id, b.reference_number, b.status, b.mix_batch_id, b.weight_kg::text AS weight_kg,
             b.cost_per_kg::text AS cost_per_kg, b.total_cost::text AS total_cost, b.article_code,
             p.production_price::text AS production_price, (p.id IS NOT NULL) AS has_product
        FROM factory_bales b
        LEFT JOIN factory_bale_products p ON p.id = b.product_id AND p.company_id = ${companyId}
       WHERE b.company_id = ${companyId} AND b.deleted_at IS NULL
         AND (
           b.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER', 'RESERVED_FOR_DISPATCH')
           OR (b.status = 'SOLD'
             -- Some legacy verification flows mark bales SOLD before the
             -- invoice exists. Those bales remain in factory finished goods.
             AND EXISTS (
               SELECT 1 FROM customer_order_bales open_cob
                 JOIN customer_orders open_co ON open_co.id = open_cob.order_id
                WHERE open_cob.bale_id = b.id
                  AND open_co.company_id = ${companyId}
                  AND open_co.deleted_at IS NULL
                  AND open_co.status = 'VERIFIED'
                  AND open_co.invoice_number IS NULL
                  AND open_co.finalized_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM factory_invoice_document_snapshots ds
                     WHERE ds.company_id = ${companyId} AND ds.order_id = open_co.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM customer_balances cb
                     WHERE cb.company_id = ${companyId}
                       AND cb.reference_type = 'INVOICE'
                       AND cb.reference_id = open_co.id
                       AND cb.transaction_type = 'SALE'
                  )
             )
             AND NOT EXISTS (
               SELECT 1 FROM factory_pos_sale_bales psb
                WHERE psb.company_id = ${companyId} AND psb.bale_id = b.id
             )
           )
         )
         -- Never recost a bale on any invoiced, completed, or marked-finalized
         -- order, even if the order was subsequently moved back to VERIFIED.
         AND NOT EXISTS (
           SELECT 1 FROM customer_order_bales cob
             JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = b.id AND co.company_id = ${companyId}
              AND co.deleted_at IS NULL
              AND (co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD', 'INVOICED', 'COMPLETED')
                   OR co.invoice_number IS NOT NULL OR co.finalized_at IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM factory_invoice_document_snapshots ds
                      WHERE ds.company_id = ${companyId} AND ds.order_id = co.id
                   )
                   -- A SALE ledger entry on any linked order is invoice evidence
                   -- too, even when the order row itself still reads VERIFIED.
                   OR EXISTS (
                     SELECT 1 FROM customer_balances cb
                      WHERE cb.company_id = ${companyId}
                        AND cb.reference_type = 'INVOICE'
                        AND cb.reference_id = co.id
                        AND cb.transaction_type = 'SALE'
                   ))
         )
       ORDER BY b.id
    `
  );

  const openMixes = await rows<MixRow>(
    tx,
    sql`
      SELECT id, batch_code, status, total_weight_kg::text AS total_weight_kg, used_kg::text AS used_kg,
             cost_per_kg::text AS cost_per_kg, total_cost::text AS total_cost
        FROM factory_mix_batches
       WHERE company_id = ${companyId} AND deleted_at IS NULL AND status <> 'CLOSED'
         AND total_weight_kg - used_kg > 0
    `
  );
  const mixIds = new Set<number>([
    ...openMixes.map((mix) => mix.id),
    ...bales.map((bale) => bale.mix_batch_id).filter((id): id is number => id !== null),
  ]);

  const mixById = new Map<number, MixRow>();
  const sourcesByMix = new Map<number, SourceRow[]>();
  const loadMixes = async (ids: number[]) => {
    const missing = ids.filter((id) => !mixById.has(id));
    if (missing.length === 0) return;
    const list = sql.join(
      missing.map((id) => sql`${id}`),
      sql`, `
    );
    for (const mix of await rows<MixRow>(
      tx,
      sql`
        SELECT id, batch_code, status, total_weight_kg::text AS total_weight_kg, used_kg::text AS used_kg,
               cost_per_kg::text AS cost_per_kg, total_cost::text AS total_cost
          FROM factory_mix_batches WHERE company_id = ${companyId} AND deleted_at IS NULL AND id IN (${list})
      `
    )) {
      mixById.set(mix.id, mix);
      sourcesByMix.set(mix.id, []);
    }
    for (const source of await rows<SourceRow>(
      tx,
      sql`
        SELECT id, mix_batch_id, container_id, supplier_id, source_batch_id, weight_kg::text AS weight_kg,
               cost_per_kg::text AS cost_per_kg
          FROM factory_mix_batch_sources WHERE mix_batch_id IN (${list}) ORDER BY id
      `
    )) {
      sourcesByMix.get(source.mix_batch_id)?.push(source);
    }
  };
  await loadMixes([...mixIds]);

  // The USD rate of each mix and of each of its sources, recomputed now.
  const mixRate = new Map<number, Decimal | null>();
  return { date, unvalued, bales, openMixes, mixIds, mixById, sourcesByMix, loadMixes, mixRate };
}
