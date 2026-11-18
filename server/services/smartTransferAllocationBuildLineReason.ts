// Extracted from ./smartTransferAllocation.ts to keep that module under the source-size cap.
import { roundNumber } from "./smartTransferPerformance";
import type { SmartTransferItemCandidate, SmartTransferSourceStock } from "./allocateWholeUnitsByWeight";

export function buildLineReason(
  candidate: SmartTransferItemCandidate,
  source: SmartTransferSourceStock,
  sourceQty: number,
  itemSuggestedTotal: number
): string {
  const perf = candidate.performance;
  const parts = [
    `${perf.classificationLabel}: ${roundNumber(perf.totalSalesSinceOlderTransfer, 0)} sold after ${roundNumber(
      perf.totalTransferredQty,
      0
    )} transferred across the last ${perf.olderTransferQty > 0 ? "4" : "1"} qualifying order(s)`,
    `destination stock ${roundNumber(perf.currentDestinationQty, 0)}`,
  ];
  if (candidate.otwQty > 0) parts.push(`OTW ${roundNumber(candidate.otwQty, 0)} included`);
  parts.push(
    `calculated need ${candidate.calculatedNeed}`,
    `${source.sourceLocationName} has ${source.availableQty} available after reserving ${source.reserveQty}`,
    `${sourceQty} allocated here (${itemSuggestedTotal} total for this item)`
  );
  return parts.join("; ") + ".";
}
