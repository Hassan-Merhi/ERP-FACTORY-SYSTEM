/** Sale classification for the historical sales-cost repair dry run. */
import Decimal from "decimal.js";

import {
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";
import { RepairCheck, SaleRow, beforeCutoff, d, iso } from "./historicalSalesCostRepairTypes";
import {
  CanonicalSaleEvidence,
  compareMovementMutationAscending,
  movementMutationTime,
  originalProposalForSale,
  proposalFromRecordedRate,
} from "./historicalSalesCostRepairEvidence";
import { markAmbiguousTimestampTies } from "./historicalSalesCostRepairRecovery";

/** Builds direct canonical proposals and the canonical replay inputs, and separates the legacy sales the repair must re-cost. */
export function classifyCompanySales({
  companyId,
  sales,
  canonicalStart,
  canonical,
  checks,
  canonicalSaleEvidence,
  canonicalSaleKeys,
  legacyMovements,
}: {
  companyId: number;
  sales: SaleRow[];
  canonicalStart: Date | null;
  canonical: HistoricalSalesRepairMovement[];
  checks: RepairCheck[];
  canonicalSaleEvidence: Map<string, CanonicalSaleEvidence>;
  canonicalSaleKeys: Set<string>;
  legacyMovements: HistoricalSalesRepairMovement[];
}): {
  directCanonicalProposals: Map<number, HistoricalSalesRepairProposal>;
  canonicalForReplay: HistoricalSalesRepairMovement[];
  normalizedCanonicalPosReplay: HistoricalSalesRepairMovement[];
  legacySales: SaleRow[];
} {
  const directCanonicalProposals = new Map<number, HistoricalSalesRepairProposal>();
  const saleQuantityByEvidenceKey = new Map<string, Decimal>();
  for (const sale of sales) {
    if (!sale.location_id) continue;
    const key = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    saleQuantityByEvidenceKey.set(
      key,
      repairQuantity((saleQuantityByEvidenceKey.get(key) ?? new Decimal(0)).plus(d(sale.quantity).abs()))
    );
  }

  const canonicalSaleLifecycleCorrections: HistoricalSalesRepairMovement[] = [];

  for (const [key, evidence] of canonicalSaleEvidence) {
    const [voucherIdText, locationIdText, stockItemIdText] = key.split(":");
    const expectedQuantity = saleQuantityByEvidenceKey.get(key);
    if (!expectedQuantity) continue;
    if (evidence.latestNegativeRate === null) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_RATE_MISSING",
        status: "block",
        detail: `Voucher ${voucherIdText} latest canonical sale mutation has no priced outbound issue`,
      });
      continue;
    }
    if (!evidence.latestNegativeQuantity.eq(expectedQuantity)) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_QUANTITY_DRIFT",
        status: "warning",
        expected: expectedQuantity.toFixed(3),
        actual: evidence.latestNegativeQuantity.toFixed(3),
        detail: `Voucher ${voucherIdText} quantity differs from its latest canonical issue batch; the exact transaction-time cost rate is still pinned by the matching latest mutation timestamp`,
      });
    }
    if (evidence.latestNegativeRates.size > 1) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_MULTI_RATE_RECONCILED",
        status: "warning",
        expected: evidence.latestNegativeRate.toFixed(2),
        actual: [...evidence.latestNegativeRates].sort().join(","),
        detail: `Voucher ${voucherIdText} latest canonical issue batch contains multiple recorded rates; using its quantity-weighted recorded cost`,
      });
    }

    const desiredSignedQuantity = repairQuantity(expectedQuantity.negated());
    const correctionDelta = repairQuantity(desiredSignedQuantity.minus(evidence.totalSignedQuantity));
    if (!correctionDelta.isZero()) {
      const rateSource = correctionDelta.lt(0)
        ? evidence.latestNegativeMovements
        : evidence.latestPositiveMovements.length > 0
          ? evidence.latestPositiveMovements
          : evidence.latestNegativeMovements;
      // V47: edit legs journal the old sale-line cost, not the live rate the
      // missing effect was executed at, so such a correction is unpriced.
      const correctionAtLiveRate =
        rateSource.length > 0 && rateSource.every((rateMovement) => posJournalCostIsNotInventoryRate(rateMovement));
      const correctionRate = correctionDelta.lt(0)
        ? evidence.latestNegativeRate
        : (evidence.latestPositiveRate ?? evidence.latestNegativeRate);
      const anchorMovement =
        evidence.latestNegativeMovements[evidence.latestNegativeMovements.length - 1] ??
        evidence.latestPositiveMovements[evidence.latestPositiveMovements.length - 1] ??
        evidence.movements[evidence.movements.length - 1];

      if (!correctionRate || evidence.anchorCanonicalId <= 0 || !anchorMovement) {
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CANONICAL_SALE_LIFECYCLE_CORRECTION_UNPROVEN",
          status: "block",
          expected: desiredSignedQuantity.toFixed(3),
          actual: evidence.totalSignedQuantity.toFixed(3),
          detail: `Voucher ${voucherIdText} canonical lifecycle differs from the current sale but has no direct rate anchor for the missing inventory effect`,
        });
      } else {
        canonicalSaleLifecycleCorrections.push({
          movementId: `canonical-correction:${evidence.anchorCanonicalId}:${voucherIdText}:${locationIdText}:${stockItemIdText}`,
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          occurredAt: anchorMovement.occurredAt,
          createdAt: new Date(evidence.latestMutationAt).toISOString(),
          sequence: evidence.anchorCanonicalId * 10 + 9,
          quantityDelta: correctionDelta.toFixed(3),
          unitCost: correctionAtLiveRate ? null : correctionRate.toFixed(2),
          sourceType: "canonical-sale-lifecycle-correction",
          sourceId: voucherIdText,
          evidence: "canonical",
        });
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CANONICAL_SALE_LIFECYCLE_CORRECTION",
          status: "pass",
          expected: desiredSignedQuantity.toFixed(3),
          actual: evidence.totalSignedQuantity.toFixed(3),
          detail: `Voucher ${voucherIdText} replay adds ${correctionDelta.toFixed(
            3
          )} units at its latest canonical mutation to match the current immutable sale state`,
        });
      }
    }
  }

  const canonicalForReplay = [...canonical, ...canonicalSaleLifecycleCorrections];

  // POS edits/deletes before the 2026-09-11 valuation hardening wrote a
  // reversal receipt followed by a replacement issue. Those canonical rows are
  // excellent lifecycle evidence but not exact valuation evidence: the
  // reversal used the then-live inventory average, while the journal unit_cost
  // stored the old sale-line cost. Build an alternate replay that collapses
  // each POS lifecycle to the final active sale state. It is never trusted on
  // its own: later forward proof accepts it only when it reproduces the
  // immutable Phase 3 checkpoint exactly.
  const normalizedCanonicalPosReplay: HistoricalSalesRepairMovement[] = canonical.filter(
    (movement) => movement.sourceType !== "pos-sale"
  );
  for (const [key, evidence] of canonicalSaleEvidence) {
    const posMovements = evidence.movements.filter((movement) => movement.sourceType === "pos-sale");
    if (posMovements.length === 0) continue;

    const expectedQuantity = saleQuantityByEvidenceKey.get(key);
    if (!expectedQuantity) {
      // The sale no longer exists. Its edit/delete lifecycle has a normalized
      // net stock effect of zero.
      continue;
    }

    const latestPosMutationAt = Math.max(...posMovements.map(movementMutationTime));
    const latestNegative = posMovements
      .filter(
        (movement) =>
          movementMutationTime(movement) === latestPosMutationAt &&
          d(movement.quantityDelta).lt(0) &&
          movement.unitCost !== null &&
          movement.unitCost !== undefined
      )
      .sort(compareMovementMutationAscending);

    let weightedQuantity = new Decimal(0);
    let weightedValue = new Decimal(0);
    for (const movement of latestNegative) {
      const quantity = d(movement.quantityDelta).abs();
      weightedQuantity = weightedQuantity.plus(quantity);
      weightedValue = weightedValue.plus(quantity.times(d(movement.unitCost)));
    }

    if (latestNegative.length === 0 || !weightedQuantity.gt(0)) {
      // Without a latest priced issue, do not normalize this lifecycle.
      normalizedCanonicalPosReplay.push(...posMovements);
      continue;
    }

    const anchor = latestNegative[latestNegative.length - 1];
    normalizedCanonicalPosReplay.push({
      ...anchor,
      quantityDelta: repairQuantity(expectedQuantity.negated()).toFixed(3),
      unitCost: repairRate(weightedValue.dividedBy(weightedQuantity)).toFixed(2),
      sourceType: "pos-sale-normalized",
      sourceId: key.split(":")[0],
    });
  }

  const legacySales: SaleRow[] = [];
  for (const sale of sales) {
    if (!sale.location_id) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(sale.stock_item_id),
        code: "SALE_LOCATION_MISSING",
        status: "block",
        detail: `Sales item ${sale.sales_item_id} / voucher ${sale.voucher_id} has no location`,
      });
      continue;
    }

    const saleEvidenceKey = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    const canonicalEvidence = canonicalSaleEvidence.get(saleEvidenceKey);
    if (canonicalEvidence) {
      if (canonicalEvidence.latestNegativeRate !== null) {
        // A canonical sale's cost is a quantity-weighted mean of its own
        // journaled live rates, so it can never leave their range.
        const recordedRates = [...canonicalEvidence.latestNegativeRates].map((rate) => d(rate));
        if (
          recordedRates.length > 0 &&
          (canonicalEvidence.latestNegativeRate.lt(Decimal.min(...recordedRates)) ||
            canonicalEvidence.latestNegativeRate.gt(Decimal.max(...recordedRates)))
        ) {
          checks.push({
            companyId,
            locationId: Number(sale.location_id),
            stockItemId: Number(sale.stock_item_id),
            salesItemId: Number(sale.sales_item_id),
            code: "CANONICAL_SALE_RATE_OUTSIDE_RECORDED",
            status: "block",
            expected: [...canonicalEvidence.latestNegativeRates].sort().join(","),
            actual: canonicalEvidence.latestNegativeRate.toFixed(2),
            detail: `Sales item ${sale.sales_item_id} proposed rate is outside the voucher's journaled live rates`,
          });
        }
        const evidenceMovement =
          canonicalEvidence.latestNegativeMovements[canonicalEvidence.latestNegativeMovements.length - 1] ??
          canonicalEvidence.movements[canonicalEvidence.movements.length - 1];
        directCanonicalProposals.set(
          Number(sale.sales_item_id),
          proposalFromRecordedRate(
            companyId,
            sale,
            canonicalEvidence.latestNegativeRate,
            evidenceMovement.sourceType,
            evidenceMovement.sourceId,
            "canonical"
          )
        );
      } else {
        directCanonicalProposals.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
      }
      continue;
    }
    if (!beforeCutoff(sale.created_at, canonicalStart)) {
      checks.push({
        companyId,
        locationId: Number(sale.location_id),
        stockItemId: Number(sale.stock_item_id),
        code: "CANONICAL_SALE_EVIDENCE_MISSING",
        status: "block",
        detail: `Sale item ${sale.sales_item_id} is after canonical cutover but has no canonical sale issue evidence`,
      });
      continue;
    }

    legacySales.push(sale);
    legacyMovements.push({
      movementId: `sale-marker:${sale.sales_item_id}`,
      companyId,
      locationId: Number(sale.location_id),
      stockItemId: Number(sale.stock_item_id),
      occurredAt: iso(sale.created_at),
      sequence: Number(sale.sales_item_id) * 10 + 5,
      quantityDelta: repairQuantity(d(sale.quantity).negated()).toFixed(3),
      unitCost: null,
      sourceType: "legacy-sale",
      sourceId: String(sale.voucher_id),
      evidence: "legacy",
      sale: {
        salesItemId: Number(sale.sales_item_id),
        voucherId: Number(sale.voucher_id),
        quantity: sale.quantity,
        totalSales: sale.total_sales,
        originalCostPrice: sale.cost_price,
        originalTotalCost: sale.total_cost,
        originalProfit: sale.profit,
      },
    });
  }

  checks.push(...markAmbiguousTimestampTies(companyId, legacyMovements, sales, canonicalStart, canonicalSaleKeys));
  return { directCanonicalProposals, canonicalForReplay, normalizedCanonicalPosReplay, legacySales };
}
