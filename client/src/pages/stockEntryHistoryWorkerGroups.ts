// Extracted from ./StockEntryHistory.tsx to keep that module under the source-size cap.
import type { ProductionResponse } from "./factory/factoryProductionTargetsModel";
import type { StockEntryWorker } from "./stockentryhistory/derived";
import type { GroupRow } from "./stockentryhistory/types";

export type StockEntryWorkerTargets = Record<
  number,
  { targetBales: number; producedBales: number; workerCount: number }
>;

/** Per-worker daily production targets keyed by person id (rows without a target are skipped). */
export function buildStockEntryWorkerTargets(
  productionTargets: ProductionResponse | undefined
): StockEntryWorkerTargets {
  const targets: Record<number, { targetBales: number; producedBales: number; workerCount: number }> = {};
  for (const row of productionTargets?.rows ?? []) {
    if (row.targetBales === null || row.targetBales === undefined) continue;
    const targetBales = Number(row.targetBales);
    const producedBales = Number(row.producedBales ?? 0);
    if (!Number.isFinite(targetBales) || !Number.isFinite(producedBales)) continue;
    targets[row.personId] = { targetBales, producedBales, workerCount: 1 };
  }
  return targets;
}

/** Groups history rows by worker, adding target-only workers with no bales yet; sorted by bale count. */
export function buildStockEntryWorkerGroups(
  groups: GroupRow[],
  workerTargets: StockEntryWorkerTargets,
  workers: StockEntryWorker[]
) {
  const workerMap = new Map<
    string,
    {
      workerKey: string;
      workerId: number | null;
      workerName: string | null;
      totalBales: number;
      totalWeight: number;
      groups: GroupRow[];
    }
  >();

  for (const group of groups) {
    const key = group.workerId != null ? String(group.workerId) : "unassigned";
    const existing = workerMap.get(key) ?? {
      workerKey: key,
      workerId: group.workerId,
      workerName: group.workerName,
      totalBales: 0,
      totalWeight: 0,
      groups: [],
    };
    existing.totalBales += group.baleCount;
    existing.totalWeight += parseFloat(group.totalWeight || "0");
    existing.groups.push(group);
    workerMap.set(key, existing);
  }

  const workerNameById = new Map(
    workers.map((worker) => [worker.id, worker.fullName ?? worker.full_name ?? worker.name ?? ""])
  );
  for (const workerIdString of Object.keys(workerTargets)) {
    const workerId = Number(workerIdString);
    const key = String(workerId);
    if (workerMap.has(key)) continue;
    workerMap.set(key, {
      workerKey: key,
      workerId,
      workerName: workerNameById.get(workerId) || null,
      totalBales: 0,
      totalWeight: 0,
      groups: [],
    });
  }

  return Array.from(workerMap.values()).sort((left, right) => right.totalBales - left.totalBales);
}
