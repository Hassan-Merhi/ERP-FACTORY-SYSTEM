// Extracted from ./smartTransferForecasting.ts to keep that module under the source-size cap.
import type { SmartTransferPreviewLine, SmartTransferSourceStock } from "./smartTransferAllocation";
import { roundNumber } from "./smartTransferPerformance";
import {
  wholeNonNegative,
  type ForecastCandidate,
  type SmartTransferDemandTrend,
  type SmartTransferUrgencyBand,
} from "./calculateWeightedForecastRate";

export function assortmentStrengthScore(line: SmartTransferPreviewLine): number {
  switch (line.classification) {
    case "strong_seller":
      return 5;
    case "good_seller":
      return 4;
    case "normal_seller":
      return 3;
    case "slow_seller":
      return 1;
    default:
      return 0;
  }
}

export function dataQualityScore(sales90: number, line: SmartTransferPreviewLine): number {
  let score = 0;
  if (sales90 >= 20) score = 4;
  else if (sales90 >= 10) score = 3;
  else if (sales90 >= 3) score = 2;
  else if (sales90 > 0) score = 1;
  if (line.olderTransferQty > 0 && line.newerTransferQty > 0) score += 1;
  return Math.min(5, score);
}

export function urgencyBand(score: number): SmartTransferUrgencyBand {
  if (score >= 80) return "critical";
  if (score >= 65) return "high";
  if (score >= 45) return "medium";
  return "low";
}

export function historicalNeedFloor(
  line: SmartTransferPreviewLine,
  trend: SmartTransferDemandTrend,
  coverageIsAlreadyEnough: boolean
): number {
  if (coverageIsAlreadyEnough) return 0;
  let multiplier: number;
  switch (line.classification) {
    case "strong_seller":
      multiplier = 0.75;
      break;
    case "good_seller":
      multiplier = 0.6;
      break;
    case "normal_seller":
      multiplier = 0.4;
      break;
    case "slow_seller":
    default:
      multiplier = 0;
      break;
  }
  if (trend === "declining") multiplier *= 0.7;
  return wholeNonNegative(Math.ceil(line.calculatedNeed * multiplier));
}

export function buildForecastReason(
  candidate: ForecastCandidate,
  source: SmartTransferSourceStock,
  sourceQty: number,
  itemTotal: number
): string {
  const score = candidate.itemScore;
  const urgency = candidate.urgencyBand.charAt(0).toUpperCase() + candidate.urgencyBand.slice(1);
  const stockoutText =
    candidate.daysUntilStockout === null
      ? "stockout timing unavailable"
      : `${roundNumber(candidate.daysUntilStockout, 1)} days of destination stock remain before weighted OTW`;
  const otwText =
    candidate.otw.rawQty > 0
      ? `${roundNumber(candidate.otw.rawQty, 0)} OTW recorded, ${roundNumber(candidate.otw.weightedQty, 0)} counted after ETA/shop reliability weighting`
      : "no destination OTW recorded";
  const trendText = candidate.sales.trend.replace("_", " ");

  return (
    [
      `Priority ${score}/100 (${urgency})`,
      `forecast ${roundNumber(candidate.sales.forecastRate, 2)}/day from 7/30/90-day sales (${roundNumber(candidate.sales.sales7, 0)}/${roundNumber(candidate.sales.sales30, 0)}/${roundNumber(candidate.sales.sales90, 0)})`,
      `trend ${trendText}`,
      stockoutText,
      otwText,
      `calculated need ${candidate.calculatedNeed}`,
      `${source.sourceLocationName} has ${source.availableQty} available after reserving ${source.reserveQty}`,
      `${sourceQty} allocated here (${itemTotal} total for this item)`,
    ].join("; ") + "."
  );
}
