import type { ScannedBale } from "./types";

export interface GroundExpectedBale {
  referenceNumber: string;
  articleCode: string;
  productName?: string;
  weightKg: string;
  stockEntryDate?: string | null;
  workerName?: string | null;
}

export interface GroundArticleReconciliation {
  articleCode: string;
  productName: string;
  systemQty: number;
  systemWt: number;
  scannedQty: number;
  scannedWt: number;
  missingQty: number;
  missingWt: number;
}

const referenceKey = (reference: string | null | undefined) =>
  (reference ?? "").trim().toUpperCase();

const articleKey = (article: string | null | undefined) =>
  article?.trim().toUpperCase() || "UNKNOWN";

const weight = (value: string | number | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Ground verification is a barcode-set comparison, never a subtraction of
 * article quantities. A scanned non-stock bale of the same article must not
 * cancel a genuinely missing in-stock bale.
 *
 * The expected list comes from the Ground Scan-specific available-stock API.
 */
export function reconcileGroundScan(
  expected: GroundExpectedBale[],
  observations: ScannedBale[],
) {
  const expectedByRef = new Map<string, GroundExpectedBale>();
  expected.forEach((bale, index) => {
    const key = referenceKey(bale.referenceNumber) || `__NO_REFERENCE_EXPECTED_${index}`;
    if (!expectedByRef.has(key)) expectedByRef.set(key, bale);
  });

  const scannedByRef = new Map<string, ScannedBale>();
  observations.forEach((bale, index) => {
    const key = referenceKey(bale.refCode) || `__NO_REFERENCE_SCANNED_${index}`;
    if (!scannedByRef.has(key)) scannedByRef.set(key, bale);
  });

  const systemBales = [...expectedByRef.values()];
  const scannedBales = [...scannedByRef.values()];
  const missingBales = [...expectedByRef.entries()]
    .filter(([ref]) => !scannedByRef.has(ref))
    .map(([, bale]) => bale);
  const extraBales = [...scannedByRef.entries()]
    .filter(([ref]) => !expectedByRef.has(ref))
    .map(([, bale]) => bale);

  const articleMap = new Map<string, GroundArticleReconciliation>();
  const ensure = (code: string, name: string) => {
    const key = articleKey(code);
    if (!articleMap.has(key)) {
      articleMap.set(key, {
        articleCode: key,
        productName: name,
        systemQty: 0,
        systemWt: 0,
        scannedQty: 0,
        scannedWt: 0,
        missingQty: 0,
        missingWt: 0,
      });
    }
    const row = articleMap.get(key)!;
    if (!row.productName && name) row.productName = name;
    return row;
  };

  for (const bale of systemBales) {
    const row = ensure(bale.articleCode, bale.productName || "");
    row.systemQty++;
    row.systemWt += weight(bale.weightKg);
  }
  for (const bale of scannedBales) {
    const row = ensure(bale.articleCode, bale.productName || "");
    row.scannedQty++;
    row.scannedWt += weight(bale.weightKg);
  }
  for (const bale of missingBales) {
    const row = ensure(bale.articleCode, bale.productName || "");
    row.missingQty++;
    row.missingWt += weight(bale.weightKg);
  }

  return {
    systemBales,
    scannedBales,
    missingBales,
    extraBales,
    summaryArticles: [...articleMap.values()].sort((a, b) => a.articleCode.localeCompare(b.articleCode)),
    totalSystemWt: systemBales.reduce((sum, bale) => sum + weight(bale.weightKg), 0),
    totalScannedWt: scannedBales.reduce((sum, bale) => sum + weight(bale.weightKg), 0),
    totalMissingWt: missingBales.reduce((sum, bale) => sum + weight(bale.weightKg), 0),
  };
}
