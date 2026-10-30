import { normalizeBonusCategory } from "./productionTargetBonusCategoryRates";

export interface CategoryEvidenceBale {
  baleId: number;
  workerId: number | null;
  category: string | null;
  finalizedAt: string | null;
}
export interface CategoryEvidenceWorker {
  workerId: number;
  workerName?: string;
  targetBales: number | null;
  savedProducedBales: number;
  status: "Present" | "Absent" | "New";
}
export interface CategoryEvidenceLink { id: number; workerIds: number[]; }
export interface CreditedCategory {
  categoryKey: string;
  categoryLabel: string;
  creditedBales: number;
  sourceBales: number;
  firstFinalizedAt: string | null;
  lastFinalizedAt: string | null;
}
export type CategoryEvidenceIssue =
  | "NO_CAPTURE" | "NO_WORKERS" | "DUPLICATE_BALE" | "UNKNOWN_WORKER"
  | "MISSING_CATEGORY" | "LINK_MEMBER_MISSING" | "OVERLAPPING_LINKS"
  | "ABSENT_FINALIZER" | "NO_PRESENT_LINK_MEMBER" | "SAVED_TOTAL_MISMATCH"
  | "INVALID_BALE";
export interface CategoryWorkerEvidence {
  workerId: number;
  workerName?: string;
  dailyTargetBales: number | null;
  savedProducedBales: number;
  creditedBales: number;
  categories: CreditedCategory[];
  issues: CategoryEvidenceIssue[];
}
export interface CategoryEvidenceResult {
  captured: boolean;
  sourceBales: number;
  creditedBales: number;
  workers: CategoryWorkerEvidence[];
  issues: CategoryEvidenceIssue[];
  readyForTargetAllocation: boolean;
}

/** Every physical bale is counted exactly once. Linked-team category bale
 * remainders rotate across categories to preserve the worker's whole-day
 * share; no worker can receive a category multiple times from one bale.
 */
export function buildCategoryEvidence(
  workers: CategoryEvidenceWorker[],
  links: CategoryEvidenceLink[],
  bales: CategoryEvidenceBale[],
  captured: boolean,
): CategoryEvidenceResult {
  const global = new Set<CategoryEvidenceIssue>();
  if (!captured) global.add("NO_CAPTURE");
  if (!workers.length) global.add("NO_WORKERS");
  const byWorker = new Map(workers.map(w => [w.workerId, w]));
  const credit = new Map<number, Map<string, CreditedCategory>>();
  const physicalCount = new Map<number, number>();
  const groups = new Map<number, number>();
  for (const link of links) {
    for (const id of new Set(link.workerIds)) {
      if (groups.has(id)) global.add("OVERLAPPING_LINKS");
      groups.set(id, link.id);
      if (!byWorker.has(id)) global.add("LINK_MEMBER_MISSING");
    }
  }
  const uniqueBales = new Set<number>();
  const validBales: Array<CategoryEvidenceBale & { categoryKey: string; categoryLabel: string }> = [];
  for (const bale of bales) {
    if (!Number.isSafeInteger(bale.baleId) || bale.baleId <= 0) {
      global.add("INVALID_BALE"); continue;
    }
    if (uniqueBales.has(bale.baleId)) { global.add("DUPLICATE_BALE"); continue; }
    uniqueBales.add(bale.baleId);
    const cat = normalizeBonusCategory(bale.category);
    if (!cat) { global.add("MISSING_CATEGORY"); continue; }
    if (!bale.workerId || !byWorker.has(bale.workerId)) { global.add("UNKNOWN_WORKER"); continue; }
    if (byWorker.get(bale.workerId)!.status === "Absent") global.add("ABSENT_FINALIZER");
    physicalCount.set(bale.workerId, (physicalCount.get(bale.workerId) ?? 0) + 1);
    validBales.push({ ...bale, categoryKey: cat.key, categoryLabel: cat.label });
  }
  const give = (workerId: number, cat: typeof validBales[number], sourceCount: number) => {
    let byCat = credit.get(workerId);
    if (!byCat) { byCat = new Map(); credit.set(workerId, byCat); }
    const prev = byCat.get(cat.categoryKey);
    const timestamp = cat.finalizedAt;
    if (!prev) {
      byCat.set(cat.categoryKey, {
        categoryKey: cat.categoryKey, categoryLabel: cat.categoryLabel,
        creditedBales: 1, sourceBales: sourceCount,
        firstFinalizedAt: timestamp, lastFinalizedAt: timestamp,
      });
    } else {
      prev.creditedBales++;
      prev.sourceBales = sourceCount;
      if (timestamp && (!prev.firstFinalizedAt || timestamp < prev.firstFinalizedAt))
        prev.firstFinalizedAt = timestamp;
      if (timestamp && (!prev.lastFinalizedAt || timestamp > prev.lastFinalizedAt))
        prev.lastFinalizedAt = timestamp;
    }
  };
  const byGroup = new Map<number, typeof validBales>();
  for (const bale of validBales) {
    const groupId = groups.get(bale.workerId!);
    if (groupId == null) { give(bale.workerId!, bale, 1); continue; }
    const existing = byGroup.get(groupId) ?? [];
    existing.push(bale); byGroup.set(groupId, existing);
  }
  for (const link of links) {
    const source = byGroup.get(link.id) ?? [];
    const members = [...new Set(link.workerIds)].sort((a,b) => a-b);
    const present = members.filter(id => byWorker.get(id)?.status !== "Absent" && byWorker.has(id));
    if (!present.length && source.length) { global.add("NO_PRESENT_LINK_MEMBER"); continue; }
    if (!present.length) continue;
    const byCat = new Map<string, typeof validBales>();
    for (const bale of source) {
      const list = byCat.get(bale.categoryKey) ?? [];
      list.push(bale); byCat.set(bale.categoryKey,list);
    }
    // Rotating remainder avoids awarding every odd-category bale to the first worker.
    let cursor = 0;
    for (const [categoryKey, rows] of [...byCat].sort(([a],[b]) => a.localeCompare(b))) {
      rows.sort((a,b) => a.baleId-b.baleId);
      const n = rows.length;
      for (let i=0;i<n;i++) {
        const recipient = present[(cursor+i)%present.length];
        give(recipient, rows[i], n);
      }
      cursor = (cursor+n)%present.length;
      void categoryKey;
    }
  }
  const outputs: CategoryWorkerEvidence[] = workers.map(w => {
    const own = credit.get(w.workerId);
    const categories = [...(own?.values() ?? [])].sort((a,b) => a.categoryLabel.localeCompare(b.categoryLabel));
    const creditedBales = categories.reduce((sum,c) => sum+c.creditedBales,0);
    const groupId=groups.get(w.workerId);
    const expected = groupId == null
      ? (physicalCount.get(w.workerId) ?? 0)
      : validBales.filter(b => groups.get(b.workerId!) === groupId).length;
    const issues: CategoryEvidenceIssue[]=[];
    if (w.savedProducedBales !== expected) { issues.push("SAVED_TOTAL_MISMATCH"); global.add("SAVED_TOTAL_MISMATCH"); }
    return {
      workerId: w.workerId, workerName: w.workerName, dailyTargetBales: w.targetBales,
      savedProducedBales: w.savedProducedBales, creditedBales,
      categories, issues,
    };
  });
  const sourceBales = uniqueBales.size;
  const creditedBales = outputs.reduce((sum,w) => sum+w.creditedBales,0);
  if (sourceBales !== creditedBales) global.add("SAVED_TOTAL_MISMATCH");
  return {
    captured, sourceBales, creditedBales, workers: outputs,
    issues: [...global], readyForTargetAllocation: captured && global.size === 0,
  };
}

/** Target portions must add to the SINGLE approved worker/day target.
 * Do not duplicate a target for each category, round away an imbalance or
 * allow a target allocation for a category with no evidence.
 */
export function validateCategoryTargetSplit(
  dailyTarget: number,
  categories: CreditedCategory[],
  parts: Array<{ categoryKey: string; targetBales: number }>,
): string | null {
  if (!Number.isSafeInteger(Math.round(dailyTarget*100)) || dailyTarget < 0 || dailyTarget > 100000)
    return "Invalid saved daily target";
  const expected = new Set(categories.map(x => x.categoryKey));
  if (parts.length !== expected.size) return "Specify each observed category exactly once";
  const seen = new Set<string>();
  let total = 0;
  for (const part of parts) {
    if (!expected.has(part.categoryKey) || seen.has(part.categoryKey)) return "Unknown or duplicate category";
    if (!Number.isFinite(part.targetBales) || part.targetBales < 0 ||
        Math.abs(Math.round(part.targetBales*100) - part.targetBales*100) > 0.000001)
      return "Target must be a nonnegative number with at most two decimal places";
    seen.add(part.categoryKey); total += Math.round(part.targetBales*100);
  }
  return total === Math.round(dailyTarget*100) ? null : "Category targets must sum to the saved daily target";
}
