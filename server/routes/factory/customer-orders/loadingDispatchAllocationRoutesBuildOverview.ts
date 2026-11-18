// Extracted from ./loadingDispatchAllocationRoutes.ts to keep that module under the source-size cap.
import { code, num, str, type Source } from "./loadingDispatchAllocationRoutesParsePlan";

export function buildOverview(s: Source, dispatchId: number, orderId: number) {
  const id = String(dispatchId);
  const baleMap = new Map(s.loaded.map((b) => [b.baleId, b]));
  const owned = s.existingBales.filter((e) => str(e.dispatchId) === id);
  const targetRows = s.existingArticles.filter((e) => str(e.dispatchId) === id);
  const ownedIds = new Set(owned.map((e) => num(e.baleId)));
  const scannedByOther = new Map(s.scans.filter((e) => str(e.dispatchId) !== id).map((e) => [num(e.baleId), e]));
  const otherExact = new Map(s.existingBales.filter((e) => str(e.dispatchId) !== id).map((e) => [num(e.baleId), e]));
  const scannedBySelf = new Set(s.scans.filter((e) => str(e.dispatchId) === id).map((e) => num(e.baleId)));
  const articles = new Map<
    string,
    {
      articleCode: string;
      productName: string;
      loadedQty: number;
      loadedWeightKg: number;
      reservedOtherQty: number;
      reservedHereQty: number;
      scannedHereQty: number;
      availableQty: number;
      expectedQty: number;
      priorityRank: number;
    }
  >();
  for (const b of s.loaded) {
    const a = articles.get(b.articleCode) ?? {
      articleCode: b.articleCode,
      productName: b.productName,
      loadedQty: 0,
      loadedWeightKg: 0,
      reservedOtherQty: 0,
      reservedHereQty: 0,
      scannedHereQty: 0,
      availableQty: 0,
      expectedQty: 0,
      priorityRank: s.queueRanks.get(b.articleCode) ?? 999999,
    };
    a.loadedQty++;
    a.loadedWeightKg += b.weightKg;
    if (ownedIds.has(b.baleId)) a.reservedHereQty++;
    if (scannedBySelf.has(b.baleId)) a.scannedHereQty++;
    articles.set(b.articleCode, a);
  }
  for (const plan of targetRows) {
    const key = code(plan.articleCode);
    const a = articles.get(key);
    if (a) a.expectedQty = num(plan.expectedQty);
  }
  // Other-trip consumption is the greater of the explicit article target,
  // exact reservations, and physical scans on each trip (never their sum).
  const otherByTrip = new Map<string, Map<string, { planned: number; exact: Set<number>; scanned: Set<number> }>>();
  const accumulate = (trip: string, article: string) => {
    let t = otherByTrip.get(trip);
    if (!t) {
      t = new Map();
      otherByTrip.set(trip, t);
    }
    let a = t.get(article);
    if (!a) {
      a = { planned: 0, exact: new Set<number>(), scanned: new Set<number>() };
      t.set(article, a);
    }
    return a;
  };
  for (const p of s.existingArticles)
    if (str(p.dispatchId) !== id) {
      accumulate(str(p.dispatchId), code(p.articleCode)).planned += num(p.expectedQty);
    }
  for (const p of s.existingBales)
    if (str(p.dispatchId) !== id) {
      const bale = baleMap.get(num(p.baleId));
      if (bale) accumulate(str(p.dispatchId), bale.articleCode).exact.add(bale.baleId);
    }
  for (const p of s.scans)
    if (str(p.dispatchId) !== id) {
      const bale = baleMap.get(num(p.baleId));
      if (bale) accumulate(str(p.dispatchId), bale.articleCode).scanned.add(bale.baleId);
    }
  for (const trip of otherByTrip.values())
    for (const [article, r] of trip) {
      const a = articles.get(article);
      if (a) a.reservedOtherQty += Math.max(r.planned, new Set([...r.exact, ...r.scanned]).size);
    }
  const list = [...articles.values()]
    .map((a) => ({
      ...a,
      availableQty: Math.max(0, a.loadedQty - a.reservedOtherQty),
      loadedWeightKg: Math.round(a.loadedWeightKg * 1000) / 1000,
    }))
    .sort((a, b) => a.priorityRank - b.priorityRank || a.articleCode.localeCompare(b.articleCode));
  const candidates = s.loaded
    .map((b) => {
      const elsewhere = otherExact.get(b.baleId) ?? scannedByOther.get(b.baleId);
      return {
        ...b,
        assignedHere: ownedIds.has(b.baleId),
        scannedHere: scannedBySelf.has(b.baleId),
        assignedElsewhere: elsewhere
          ? { dispatchId: str(elsewhere.dispatchId), dispatchNumber: num(elsewhere.dispatchNumber) }
          : null,
      };
    })
    .sort(
      (a, b) =>
        (s.queueRanks.get(a.articleCode) ?? 999999) - (s.queueRanks.get(b.articleCode) ?? 999999) ||
        a.orderIndex - b.orderIndex
    );
  return {
    orderId,
    dispatchId,
    status: s.trip.status,
    priority: s.priority
      ? {
          orderPriority: num(s.priority.priority),
          color: str(s.priority.color),
          enabled: s.priority.enabled === true,
          source: "loading_priority_scan_queue",
        }
      : null,
    articleOrdering: "linked_proforma_then_loading_lines",
    articles: list,
    candidates,
    expectedArticles: targetRows.map((r) => ({
      articleCode: code(r.articleCode),
      expectedQty: num(r.expectedQty),
      priorityRank: r.priorityRank == null ? null : num(r.priorityRank),
    })),
    expectedBales: owned.map((r) => ({
      baleId: num(r.baleId),
      ...(() => {
        const b = baleMap.get(num(r.baleId));
        return b
          ? { baleReference: b.baleReference, articleCode: b.articleCode }
          : { baleReference: "", articleCode: "" };
      })(),
    })),
    otherTrips: [...otherByTrip].map(([trip, map]) => ({
      dispatchId: trip,
      reservedArticles: [...map].map(([articleCode, v]) => ({
        articleCode,
        reservedQty: Math.max(v.planned, new Set([...v.exact, ...v.scanned]).size),
      })),
    })),
  };
}
