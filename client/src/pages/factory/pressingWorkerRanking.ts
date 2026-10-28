/** Client-side presentation only: ranks confirmed KG from the authorized team totals endpoint.
 * Equal KG values receive the same standing, avoiding arbitrary winners.
 * No confirmed KG means no ranking at all.
 */
export interface PressingWorkerTotal {
  userId: string;
  name: string;
  totalBales: number;
  totalKg: string;
}

export type PressingStanding = "leading" | "middle" | "lowest" | "unranked";

function safeKg(kg: string): number {
  const value = Number(kg);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function rankPressingWorkers(workers: PressingWorkerTotal[]): Array<
  PressingWorkerTotal & { standing: PressingStanding; percentOfLeader: number }
> {
  const ordered = [...workers].sort((a, b) =>
    safeKg(b.totalKg) - safeKg(a.totalKg) ||
    a.name.localeCompare(b.name) ||
    a.userId.localeCompare(b.userId),
  );
  const levels = [...new Set(ordered.map(worker => safeKg(worker.totalKg)))];
  const highest = levels[0] || 0;
  const lowest = levels[levels.length - 1] || 0;
  return ordered.map(worker => {
    const kg = safeKg(worker.totalKg);
    const standing: PressingStanding = highest === 0 ? "unranked"
      : kg === highest ? "leading"
      : kg === lowest ? "lowest" : "middle";
    return {
      ...worker,
      standing,
      percentOfLeader: highest > 0 ? Math.max(0, Math.min(100, Math.round((kg / highest) * 100))) : 0,
    };
  });
}
