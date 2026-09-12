import { sql } from "drizzle-orm";
import { db } from "../../db";
import { pn, money, loadTargetAccounts, mapTargetAccount } from "./spMigrationPhase2Common";
import { resultRows, firstRow } from "../../lib/queryResult";

export type ChargeCandidate = {
  sourceKey: string;
  sourceKind: string;
  sourceRowId?: number | null;
  chargeType: string;
  amountUsd: number;
  sourceLedgerAccountId?: number | null;
  notes?: string | null;
};

export async function upsertChargeMapping(params: {
  runId: string;
  sourceId: number;
  targetId: number;
  sourceContainerId: number;
  spContainerId: number;
  candidate: ChargeCandidate;
  sourceAccounts: Map<number, Record<string, unknown>>;
  targetAccounts: Awaited<ReturnType<typeof loadTargetAccounts>>;
}): Promise<{ reviewStatus: string; amountUsd: number; inserted: boolean }> {
  const { candidate } = params;
  const sourceAccount = candidate.sourceLedgerAccountId
    ? (params.sourceAccounts.get(candidate.sourceLedgerAccountId) ?? null)
    : null;
  const mapped = mapTargetAccount(sourceAccount, params.targetAccounts);

  const upsertResult = await db.execute(sql`
    INSERT INTO sp_migration_container_charges
      (run_id, source_company_id, target_company_id, source_container_id, sp_container_id,
       source_key, source_kind, source_row_id, charge_type, amount_usd,
       source_ledger_account_id, target_ledger_account_id, mapping_method, review_status, notes)
    VALUES
      (${params.runId}, ${params.sourceId}, ${params.targetId}, ${params.sourceContainerId}, ${params.spContainerId},
       ${candidate.sourceKey}, ${candidate.sourceKind}, ${candidate.sourceRowId ?? null}, ${candidate.chargeType}, ${money(candidate.amountUsd)},
       ${candidate.sourceLedgerAccountId ?? null}, ${mapped.targetAccountId}, ${mapped.method}, ${mapped.reviewStatus}, ${candidate.notes ?? null})
    ON CONFLICT (target_company_id, source_container_id, source_key)
    DO UPDATE SET
      sp_container_id = EXCLUDED.sp_container_id,
      charge_type = EXCLUDED.charge_type,
      amount_usd = EXCLUDED.amount_usd,
      source_ledger_account_id = EXCLUDED.source_ledger_account_id,
      target_ledger_account_id = CASE
        WHEN sp_migration_container_charges.mapping_method = 'manual_approval'
          THEN sp_migration_container_charges.target_ledger_account_id
        ELSE EXCLUDED.target_ledger_account_id
      END,
      mapping_method = CASE
        WHEN sp_migration_container_charges.mapping_method = 'manual_approval'
          THEN sp_migration_container_charges.mapping_method
        ELSE EXCLUDED.mapping_method
      END,
      review_status = CASE
        WHEN sp_migration_container_charges.mapping_method = 'manual_approval'
          THEN sp_migration_container_charges.review_status
        ELSE EXCLUDED.review_status
      END,
      notes = CASE
        WHEN sp_migration_container_charges.mapping_method = 'manual_approval'
          THEN trim(COALESCE(sp_migration_container_charges.notes, '') || ' Source amount refreshed during final synchronization.')
        ELSE EXCLUDED.notes
      END
    RETURNING id, (xmax = 0) AS inserted, review_status
  `);

  return {
    reviewStatus: String(firstRow(upsertResult)?.review_status ?? mapped.reviewStatus),
    amountUsd: candidate.amountUsd,
    inserted: Boolean(firstRow(upsertResult)?.inserted),
  };
}

function addPositiveCharge(candidates: ChargeCandidate[], candidate: ChargeCandidate): void {
  if (Math.abs(candidate.amountUsd) > 0.0001) candidates.push(candidate);
}

export async function getContainerChargeCandidates(
  container: Record<string, unknown>,
  po: Record<string, unknown> | null
): Promise<ChargeCandidate[]> {
  const candidates: ChargeCandidate[] = [];

  if (po) {
    addPositiveCharge(candidates, {
      sourceKey: "po:surcharge",
      sourceKind: "purchase_order",
      sourceRowId: pn(po.id),
      chargeType: "Surcharge",
      amountUsd: pn(po.surcharge),
    });
    addPositiveCharge(candidates, {
      sourceKey: "po:fumigation",
      sourceKind: "purchase_order",
      sourceRowId: pn(po.id),
      chargeType: "Fumigation",
      amountUsd: pn(po.fumigation),
    });
    addPositiveCharge(candidates, {
      sourceKey: "po:document_charges",
      sourceKind: "purchase_order",
      sourceRowId: pn(po.id),
      chargeType: "Document Charges",
      amountUsd: pn(po.document_charges),
    });
    addPositiveCharge(candidates, {
      sourceKey: "po:other_charges",
      sourceKind: "purchase_order",
      sourceRowId: pn(po.id),
      chargeType: "Other PO Charges",
      amountUsd: pn(po.other_charges),
    });
    addPositiveCharge(candidates, {
      sourceKey: "po:discount",
      sourceKind: "purchase_order",
      sourceRowId: pn(po.id),
      chargeType: "Invoice Discount",
      amountUsd: -Math.abs(pn(po.discount)),
      notes: "Negative amount reduces landed cost.",
    });
  }

  const customResult = await db.execute(sql`
    SELECT id, charge_type, amount, ledger_account_id
    FROM container_charges
    WHERE container_id = ${pn(container.id)}
    ORDER BY id ASC
  `);
  for (const row of resultRows<{
    id: number;
    charge_type: string | null;
    amount: string | null;
    ledger_account_id: number | null;
  }>(customResult)) {
    addPositiveCharge(candidates, {
      sourceKey: `container_charge:${row.id}`,
      sourceKind: "container_charge",
      sourceRowId: pn(row.id),
      chargeType: row.charge_type || "Container Charge",
      amountUsd: pn(row.amount),
      sourceLedgerAccountId: row.ledger_account_id ? pn(row.ledger_account_id) : null,
    });
  }

  const offloadResult = await db.execute(sql`
    SELECT id, duties, office_charges, transfer_charges, transport_fees, total_charges, offloaded_at
    FROM container_offloads
    WHERE container_id = ${pn(container.id)}
    ORDER BY id DESC
    LIMIT 1
  `);
  const offload = firstRow(offloadResult) ?? null;
  if (offload) {
    addPositiveCharge(candidates, {
      sourceKey: "offload:duties",
      sourceKind: "offload",
      sourceRowId: pn(offload.id),
      chargeType: "Duties",
      amountUsd: pn(offload.duties),
    });
    addPositiveCharge(candidates, {
      sourceKey: "offload:office_charges",
      sourceKind: "offload",
      sourceRowId: pn(offload.id),
      chargeType: "Office Charges",
      amountUsd: pn(offload.office_charges),
    });
    addPositiveCharge(candidates, {
      sourceKey: "offload:transfer_charges",
      sourceKind: "offload",
      sourceRowId: pn(offload.id),
      chargeType: "Transfer Charges",
      amountUsd: pn(offload.transfer_charges),
    });
    addPositiveCharge(candidates, {
      sourceKey: "offload:transport_fees",
      sourceKind: "offload",
      sourceRowId: pn(offload.id),
      chargeType: "Transport Fees",
      amountUsd: pn(offload.transport_fees),
    });
  } else {
    addPositiveCharge(candidates, {
      sourceKey: "container:duty_fee",
      sourceKind: "container",
      sourceRowId: pn(container.id),
      chargeType: "Duty Fee",
      amountUsd: pn(container.duty_fee),
      notes: "Tracking-level fallback; no offload charge row existed.",
    });
    addPositiveCharge(candidates, {
      sourceKey: "container:transport_fee",
      sourceKind: "container",
      sourceRowId: pn(container.id),
      chargeType: "Transport Fee",
      amountUsd: pn(container.transport_fee),
      notes: "Tracking-level fallback; no offload charge row existed.",
    });
  }

  const representedFromPo = po
    ? pn(po.freight) +
      pn(po.surcharge) +
      pn(po.fumigation) +
      pn(po.document_charges) +
      pn(po.other_charges) -
      Math.abs(pn(po.discount))
    : 0;
  const sourceChargesTotal = pn(container.charges_total);
  const residual = sourceChargesTotal - representedFromPo;
  if (sourceChargesTotal !== 0 && Math.abs(residual) > 0.01) {
    addPositiveCharge(candidates, {
      sourceKey: "residual:charges_total",
      sourceKind: "reconciliation",
      sourceRowId: pn(container.id),
      chargeType: "Unclassified Charge Residual",
      amountUsd: residual,
      notes: `Source charges_total ${sourceChargesTotal.toFixed(2)} minus represented PO charges ${representedFromPo.toFixed(2)}. Review for duplicates against custom/offload charges.`,
    });
  }

  return candidates;
}

export async function getSourceContainerLines(
  container: Record<string, unknown>,
  po: Record<string, unknown> | null
): Promise<{ source: string; rows: Record<string, unknown>[] }> {
  if (po) {
    const poLines = await db.execute(sql`
      SELECT li.stock_item_id, COALESCE(si.code, li.item_name) AS article_code,
             COALESCE(si.name, li.item_name) AS description, li.quantity, li.rate
      FROM po_line_items li
      LEFT JOIN stock_items si ON si.id = li.stock_item_id
      WHERE li.po_id = ${pn(po.id)}
      ORDER BY li.id ASC
    `);
    if (resultRows(poLines).length > 0) {
      return { source: "purchase_order", rows: resultRows(poLines) };
    }
  }

  const offloadLines = await db.execute(sql`
    SELECT oi.stock_item_id, si.code AS article_code, si.name AS description,
           SUM(oi.quantity)::numeric AS quantity,
           CASE WHEN SUM(oi.quantity::numeric) = 0 THEN 0
                ELSE SUM(oi.total_value::numeric) / SUM(oi.quantity::numeric) END AS rate
    FROM container_offloads o
    JOIN container_offload_items oi ON oi.offload_id = o.id
    JOIN stock_items si ON si.id = oi.stock_item_id
    WHERE o.container_id = ${pn(container.id)}
    GROUP BY oi.stock_item_id, si.code, si.name
    ORDER BY si.code ASC
  `);
  if (resultRows(offloadLines).length > 0) {
    return { source: "offload_items", rows: resultRows(offloadLines) };
  }

  const qty = pn(container.total_kg);
  if (String(container.item_name ?? "").trim() && qty > 0) {
    const itemName = String(container.item_name).trim();
    const sourceItemResult = await db.execute(sql`
      SELECT id, code, name
      FROM stock_items
      WHERE company_id = ${pn(container.company_id)}
        AND deleted_at IS NULL
        AND (lower(code) = lower(${itemName}) OR lower(name) = lower(${itemName}))
      ORDER BY CASE WHEN lower(code) = lower(${itemName}) THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `);
    const sourceItem = firstRow(sourceItemResult) ?? null;
    const rate = pn(container.rate_per_kg) || (qty > 0 ? pn(container.items_total) / qty : 0);
    return {
      source: "container_summary",
      rows: [
        {
          stock_item_id: sourceItem?.id ?? null,
          article_code: sourceItem?.code ?? itemName,
          description: sourceItem?.name ?? itemName,
          quantity: qty,
          rate,
        },
      ],
    };
  }

  return { source: "unresolved", rows: [] };
}
