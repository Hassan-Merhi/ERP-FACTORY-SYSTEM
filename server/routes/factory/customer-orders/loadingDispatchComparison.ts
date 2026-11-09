/**
 * Pure comparison logic for Factory loading / truck verification.
 *
 * Option A: these calculations never change loading, scan, stock or ledger data.
 * An unplanned truck is NOT treated as having zero expected bales.
 * Phase 5 will populate article / exact-bale expected allocations.
 */
export interface ComparisonBale {
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
}

export interface ComparisonScan extends ComparisonBale {
  scanId: string;
  dispatchId: string;
  dispatchNumber: number;
  scannedBy: string;
  scannedAt: string;
}

export interface ComparisonExpectedBale extends ComparisonBale {
  dispatchId: string;
}

export interface ComparisonExpectedArticle {
  dispatchId: string;
  articleCode: string;
  productName: string;
  expectedQty: number;
  priorityRank: number | null;
}

export interface ComparisonTrip {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
}

export interface ComparisonArticleRow {
  articleCode: string;
  productName: string;
  expectedQty: number | null;
  scannedQty: number;
  matchedQty: number;
  missingQty: number | null;
  extraQty: number;
  expectedWeightKg: number | null;
  scannedWeightKg: number;
  priorityRank: number | null;
  status: "MATCH" | "MISSING" | "EXTRA" | "BOTH" | "UNPLANNED";
}

export interface ComparisonBaleFinding extends ComparisonBale {
  reason: string;
  dispatchId?: string;
  dispatchNumber?: number;
  expectedDispatchNumber?: number;
  scannedBy?: string;
  scannedAt?: string;
}

export interface LoadingDispatchComparison {
  scope: "overall" | "trip";
  dispatch: ComparisonTrip | null;
  planSource: "none" | "article" | "bale" | "mixed" | "loading";
  hasTripPlan: boolean;
  summary: {
    loadedBales: number;
    loadedWeightKg: number;
    expectedBales: number | null;
    expectedWeightKg: number | null;
    weightDifferenceKg: number | null;
    verifiedBales: number;
    verifiedWeightKg: number;
    matchedBales: number;
    missingBales: number | null;
    unexpectedBales: number;
    exactMissingBales: number;
    crossTripMisplacedBales: number;
    duplicateBales: number;
    progressPercent: number | null;
  };
  articles: ComparisonArticleRow[];
  missingBales: ComparisonBaleFinding[];
  unexpectedBales: ComparisonBaleFinding[];
  crossTripBales: ComparisonBaleFinding[];
  duplicateBales: ComparisonBaleFinding[];
  trips: Array<ComparisonTrip & { scannedBales: number; scannedWeightKg: number }>;
}

function articleKey(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase() || "(NO ARTICLE)";
}
function weight(n: number): number { return Number.isFinite(n) ? n : 0; }
function roundKg(n: number): number { return Math.round(n * 1000) / 1000; }
function baleFinding(b: ComparisonBale, reason: string): ComparisonBaleFinding {
  return { ...b, reason };
}

export function compareFactoryLoadingDispatch(input: {
  loaded: ComparisonBale[];
  scans: ComparisonScan[];
  expectedBales: ComparisonExpectedBale[];
  expectedArticles: ComparisonExpectedArticle[];
  trips: ComparisonTrip[];
  selectedDispatchId?: string;
}): LoadingDispatchComparison {
  const { loaded, scans, expectedBales, expectedArticles, trips, selectedDispatchId } = input;
  const trip = selectedDispatchId
    ? trips.find((row) => row.id === selectedDispatchId) ?? null
    : null;
  const byTrip = selectedDispatchId !== undefined;
  const scopedScans = byTrip ? scans.filter((s) => s.dispatchId === selectedDispatchId) : scans;
  const scopedPlannedBales = byTrip
    ? expectedBales.filter((b) => b.dispatchId === selectedDispatchId)
    : [];
  const scopedPlannedArticles = byTrip
    ? expectedArticles.filter((a) => a.dispatchId === selectedDispatchId)
    : [];
  const hasTripPlan = scopedPlannedBales.length > 0 || scopedPlannedArticles.length > 0;
  const planSource: LoadingDispatchComparison["planSource"] = !byTrip ? "loading"
    : scopedPlannedBales.length && scopedPlannedArticles.length ? "mixed"
    : scopedPlannedBales.length ? "bale"
    : scopedPlannedArticles.length ? "article" : "none";

  // Loading is authoritative for every currently loaded bale.
  const loadedMap = new Map<number, ComparisonBale>();
  for (const bale of loaded) loadedMap.set(bale.baleId, bale);
  const plannedByBale = new Map<number, ComparisonExpectedBale>();
  for (const bale of expectedBales) plannedByBale.set(bale.baleId, bale);
  const scansByBale = new Map<number, ComparisonScan[]>();
  for (const scan of scans) {
    const existing = scansByBale.get(scan.baleId) ?? [];
    existing.push(scan);
    scansByBale.set(scan.baleId, existing);
  }
  const scopedByBale = new Map<number, ComparisonScan>();
  for (const scan of scopedScans) scopedByBale.set(scan.baleId, scan);
  const activeScanIds = new Set(scopedByBale.keys());
  const selectedPlanIds = new Set(scopedPlannedBales.map((b) => b.baleId));
  const tripNumber = (id: string) => trips.find((d) => d.id === id)?.dispatchNumber;

  const missingBales: ComparisonBaleFinding[] = [];
  const unexpectedBales: ComparisonBaleFinding[] = [];
  const crossTripBales: ComparisonBaleFinding[] = [];
  const duplicateBales: ComparisonBaleFinding[] = [];

  // The overall comparison can always list exact loaded refs not yet scanned.
  if (!byTrip) {
    for (const bale of loadedMap.values()) {
      if (!scansByBale.has(bale.baleId)) missingBales.push(baleFinding(bale, "NOT_VERIFIED_ON_ANY_TRIP"));
    }
  } else if (hasTripPlan) {
    // Exact trip missing refs are known only when an exact allocation exists.
    for (const planned of scopedPlannedBales) {
      if (!activeScanIds.has(planned.baleId)) {
        const actual = loadedMap.get(planned.baleId) ?? planned;
        missingBales.push(baleFinding(actual,
          loadedMap.has(planned.baleId) ? "EXPECTED_NOT_SCANNED" : "PLAN_BALE_NO_LONGER_LOADED"));
        const elsewhere = (scansByBale.get(planned.baleId) ?? []).find((s) => s.dispatchId !== selectedDispatchId);
        if (elsewhere) {
          crossTripBales.push({
            ...actual, reason: "PLANNED_HERE_SCANNED_ELSEWHERE",
            dispatchId: elsewhere.dispatchId, dispatchNumber: elsewhere.dispatchNumber,
            scannedBy: elsewhere.scannedBy, scannedAt: elsewhere.scannedAt,
          });
        }
      }
    }
  }

  // Unexpected physical scans are still visible when a bale is removed from
  // the main loading after scanning, or when an exact plan assigns it elsewhere.
  for (const scan of scopedScans) {
    const assigned = plannedByBale.get(scan.baleId);
    if (!loadedMap.has(scan.baleId)) {
      unexpectedBales.push({ ...scan, reason: "NO_LONGER_IN_LOADING", dispatchId: scan.dispatchId,
        dispatchNumber: scan.dispatchNumber, scannedBy: scan.scannedBy, scannedAt: scan.scannedAt });
    } else if (assigned && assigned.dispatchId !== scan.dispatchId) {
      const mismatch: ComparisonBaleFinding = {
        ...scan, reason: "ASSIGNED_TO_ANOTHER_TRIP", dispatchId: scan.dispatchId,
        dispatchNumber: scan.dispatchNumber,
        expectedDispatchNumber: tripNumber(assigned.dispatchId),
        scannedBy: scan.scannedBy, scannedAt: scan.scannedAt,
      };
      unexpectedBales.push(mismatch);
      if (!byTrip) {
        crossTripBales.push({ ...mismatch, reason: "SCANNED_DIFFERENT_TRIP" });
      }
    } else if (byTrip && hasTripPlan && !selectedPlanIds.has(scan.baleId) &&
        !scopedPlannedArticles.some((article) =>
          articleKey(article.articleCode) === articleKey(scan.articleCode))) {
      unexpectedBales.push({ ...scan, reason: "NOT_IN_TRIP_PLAN",
        dispatchId: scan.dispatchId, dispatchNumber: scan.dispatchNumber,
        scannedBy: scan.scannedBy, scannedAt: scan.scannedAt });
    }
  }

  // Database uniqueness should make this empty. Report anomalous data rather
  // than hiding it or treating a duplicate as a second verified bale.
  if (!byTrip) {
    for (const sameBale of scansByBale.values()) {
      if (sameBale.length <= 1) continue;
      for (const scan of sameBale.slice(1)) {
        duplicateBales.push({ ...scan, reason: "DUPLICATE_ACTIVE_VERIFICATION",
          dispatchId: scan.dispatchId, dispatchNumber: scan.dispatchNumber,
          scannedBy: scan.scannedBy, scannedAt: scan.scannedAt });
      }
    }
  }

  type Accumulator = {
    articleCode: string; productName: string; loadedQty: number; loadedWeightKg: number;
    scannedQty: number; scannedWeightKg: number; matchedQty: number;
    plannedQty: number | null; plannedWeightKg: number; hasExactPlan: boolean;
    priorityRank: number | null;
  };
  const groups = new Map<string, Accumulator>();
  function group(code: string, name = ""): Accumulator {
    const key = articleKey(code);
    let found = groups.get(key);
    if (!found) {
      found = { articleCode: key, productName: name, loadedQty: 0,
        loadedWeightKg: 0, scannedQty: 0, scannedWeightKg: 0, matchedQty: 0,
        plannedQty: null, plannedWeightKg: 0, hasExactPlan: false, priorityRank: null };
      groups.set(key, found);
    }
    if (name && !found.productName) found.productName = name;
    return found;
  }

  for (const bale of loadedMap.values()) {
    const g = group(bale.articleCode, bale.productName);
    g.loadedQty += 1;
    g.loadedWeightKg += weight(bale.weightKg);
  }
  for (const scan of scopedByBale.values()) {
    const b = loadedMap.get(scan.baleId) ?? scan;
    const g = group(b.articleCode, b.productName);
    g.scannedQty += 1;
    g.scannedWeightKg += weight(scan.weightKg);
    if (loadedMap.has(scan.baleId)) g.matchedQty += 1;
  }

  if (byTrip) {
    for (const expected of scopedPlannedBales) {
      const b = loadedMap.get(expected.baleId) ?? expected;
      const g = group(b.articleCode, b.productName);
      g.plannedQty = (g.plannedQty ?? 0) + 1;
      g.plannedWeightKg += weight(b.weightKg);
      g.hasExactPlan = true;
    }
    // Priority article quantities supersede exact counts for article totals.
    // Exact bale allocations remain authoritative for missing-reference lists.
    for (const expected of scopedPlannedArticles) {
      const g = group(expected.articleCode, expected.productName);
      g.plannedQty = Math.max(0, expected.expectedQty);
      g.priorityRank = expected.priorityRank;
    }
  }

  // Exact assigned references must override a superficial article-level
  // quantity match: 6 different scanned bales cannot satisfy 6 planned IDs.
  const exactMissingByArticle = new Map<string, number>();
  for (const bale of missingBales) {
    const k = articleKey(bale.articleCode);
    exactMissingByArticle.set(k, (exactMissingByArticle.get(k) ?? 0) + 1);
  }
  const unexpectedByArticle = new Map<string, number>();
  for (const bale of unexpectedBales) {
    const k = articleKey(bale.articleCode);
    unexpectedByArticle.set(k, (unexpectedByArticle.get(k) ?? 0) + 1);
  }

  const articles: ComparisonArticleRow[] = [...groups.values()]
    .filter((g) => !byTrip || g.scannedQty > 0 || g.plannedQty !== null)
    .map((g) => {
    const expectedQty = !byTrip ? g.loadedQty
      : !hasTripPlan ? null : (g.plannedQty ?? 0);
    // A trip without a plan has no meaningful missing/extra count for
    // individual article types: 0 expected would incorrectly mean "extra".
    const missingQty = expectedQty === null ? null
      : Math.max(
          0, expectedQty - (byTrip ? g.scannedQty : g.matchedQty),
          byTrip ? (exactMissingByArticle.get(g.articleCode) ?? 0) : 0
        );
    const extraQty = expectedQty === null ? 0
      : byTrip ? Math.max(0, g.scannedQty - expectedQty,
          unexpectedByArticle.get(g.articleCode) ?? 0)
      : Math.max(0, g.scannedQty - g.matchedQty);
    const matchedQty = expectedQty === null ? g.matchedQty
      : Math.max(0, expectedQty - (missingQty ?? 0));
    const status: ComparisonArticleRow["status"] = expectedQty === null ? "UNPLANNED"
      : missingQty! > 0 && extraQty > 0 ? "BOTH"
      : missingQty! > 0 ? "MISSING"
      : extraQty > 0 ? "EXTRA" : "MATCH";
    return {
      articleCode: g.articleCode, productName: g.productName,
      expectedQty, scannedQty: g.scannedQty, matchedQty,
      missingQty, extraQty,
      expectedWeightKg: byTrip ? (g.hasExactPlan ? roundKg(g.plannedWeightKg) : null)
        : roundKg(g.loadedWeightKg),
      scannedWeightKg: roundKg(g.scannedWeightKg),
      priorityRank: g.priorityRank,
      status,
    };
  });
  articles.sort((a, b) =>
    (a.priorityRank ?? Number.MAX_SAFE_INTEGER) - (b.priorityRank ?? Number.MAX_SAFE_INTEGER) ||
    a.articleCode.localeCompare(b.articleCode));

  // For a trip with no plan, the loaded article types are still useful
  // context, but they are not a claimed truck-by-truck allocation.
  const expectedBalesCount = !byTrip ? loadedMap.size
    : !hasTripPlan ? null
    : articles.reduce((sum, g) => sum + (g.expectedQty ?? 0), 0);
  const expectedWeightKg = !byTrip ? roundKg([...loadedMap.values()].reduce((sum,b) => sum + weight(b.weightKg), 0))
    : scopedPlannedArticles.length ? null
    : scopedPlannedBales.length ? roundKg(scopedPlannedBales.reduce((sum,b) =>
      sum + weight((loadedMap.get(b.baleId) ?? b).weightKg), 0)) : null;

  const verifiedBales = scopedByBale.size;
  const verifiedWeightKg = roundKg([...scopedByBale.values()].reduce((sum, b) => sum + weight(b.weightKg), 0));
  const matchedBales = !byTrip
    ? [...scopedByBale.keys()].filter((id) => loadedMap.has(id)).length
    : !hasTripPlan ? [...scopedByBale.keys()].filter((id) => loadedMap.has(id)).length
    : articles.reduce((sum, row) => sum + row.matchedQty, 0);
  const missingQtyTotal = expectedBalesCount === null ? null
    : articles.reduce((sum, row) => sum + (row.missingQty ?? 0), 0);

  const tripSummaries = trips.map((d) => {
    const tripScans = scans.filter((scan) => scan.dispatchId === d.id);
    return {
      ...d, scannedBales: new Set(tripScans.map((scan) => scan.baleId)).size,
      scannedWeightKg: roundKg(tripScans.reduce((sum, scan) => sum + weight(scan.weightKg), 0)),
    };
  });
  const byReference = (a: ComparisonBaleFinding, b: ComparisonBaleFinding) =>
    a.articleCode.localeCompare(b.articleCode) || a.baleReference.localeCompare(b.baleReference);
  missingBales.sort(byReference);
  unexpectedBales.sort(byReference);
  crossTripBales.sort(byReference);
  duplicateBales.sort(byReference);

  return {
    scope: byTrip ? "trip" : "overall", dispatch: trip, planSource, hasTripPlan,
    summary: {
      loadedBales: loadedMap.size,
      loadedWeightKg: roundKg([...loadedMap.values()].reduce((sum,b) => sum + weight(b.weightKg), 0)),
      expectedBales: expectedBalesCount, expectedWeightKg,
      weightDifferenceKg: expectedWeightKg === null ? null : roundKg(expectedWeightKg - verifiedWeightKg),
      verifiedBales, verifiedWeightKg, matchedBales,
      missingBales: missingQtyTotal,
      unexpectedBales: unexpectedBales.length,
      exactMissingBales: missingBales.length,
      crossTripMisplacedBales: crossTripBales.length,
      duplicateBales: duplicateBales.length,
      progressPercent: expectedBalesCount === null ? null
        : expectedBalesCount === 0 ? (verifiedBales === 0 ? 100 : 0)
        : Math.min(100, Math.round(100 * matchedBales / expectedBalesCount)),
    },
    articles, missingBales, unexpectedBales, crossTripBales, duplicateBales,
    trips: tripSummaries,
  };
}
