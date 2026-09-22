export interface ProductionBonusMemberSnapshot {
  workerId: number;
  workerName: string;
}

export interface ProductionBonusAllocationPreview extends ProductionBonusMemberSnapshot {
  amount: number;
}

export interface ProductionBonusPreview {
  extraBales: number;
  bonusPool: number;
  allocations: ProductionBonusAllocationPreview[];
  perWorkerMin: number;
  perWorkerMax: number;
  distributable: boolean;
}

function moneyFromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function splitCents(totalCents: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  const remainderStart = count - remainder;
  return Array.from({ length: count }, (_, index) => base + (remainder > 0 && index >= remainderStart ? 1 : 0));
}

/**
 * Calculate a deterministic, cents-safe production bonus preview.
 *
 * A target of 0 means "no target" and therefore cannot generate an extra-bale
 * bonus. Linked workers are treated as one bonus unit: the unit receives one
 * equal team share, then that share is split equally between its linked members.
 * This keeps a two-worker team at a true 50/50 split without giving the linked
 * pair two full shares of the same shared production.
 */
export function calculateProductionBonusPreview(input: {
  targetBales: number;
  actualBales: number;
  bonusPerExtraBale: number;
  bonusEnabled: boolean;
  members: ProductionBonusMemberSnapshot[];
  linkedWorkerGroups?: number[][];
}): ProductionBonusPreview {
  const targetBales = Math.max(0, Math.trunc(Number(input.targetBales) || 0));
  const actualBales = Math.max(0, Math.trunc(Number(input.actualBales) || 0));
  const rate = Math.max(0, Number(input.bonusPerExtraBale) || 0);
  const extraBales = targetBales > 0 ? Math.max(actualBales - targetBales, 0) : 0;
  const poolCents = input.bonusEnabled ? Math.max(0, Math.round(extraBales * rate * 100 + Number.EPSILON)) : 0;
  const bonusPool = moneyFromCents(poolCents);

  const membersById = new Map<number, ProductionBonusMemberSnapshot>();
  for (const member of input.members) {
    if (!Number.isInteger(member.workerId) || member.workerId <= 0 || membersById.has(member.workerId)) continue;
    membersById.set(member.workerId, member);
  }
  const members = [...membersById.values()].sort((a, b) => a.workerId - b.workerId);

  if (poolCents === 0 || members.length === 0) {
    return {
      extraBales,
      bonusPool,
      allocations: members.map((member) => ({ ...member, amount: 0 })),
      perWorkerMin: 0,
      perWorkerMax: 0,
      distributable: poolCents === 0 || members.length > 0,
    };
  }

  const assigned = new Set<number>();
  const units: ProductionBonusMemberSnapshot[][] = [];

  for (const rawGroup of input.linkedWorkerGroups ?? []) {
    const group = [...new Set(rawGroup)]
      .map((workerId) => membersById.get(Number(workerId)))
      .filter((member): member is ProductionBonusMemberSnapshot => Boolean(member) && !assigned.has(member!.workerId))
      .sort((a, b) => a.workerId - b.workerId);

    if (group.length < 2) continue;
    group.forEach((member) => assigned.add(member.workerId));
    units.push(group);
  }

  for (const member of members) {
    if (!assigned.has(member.workerId)) units.push([member]);
  }
  units.sort((left, right) => left[0].workerId - right[0].workerId);

  const unitCents = splitCents(poolCents, units.length);
  const allocations: ProductionBonusAllocationPreview[] = [];
  units.forEach((unit, unitIndex) => {
    const memberCents = splitCents(unitCents[unitIndex] ?? 0, unit.length);
    unit.forEach((member, memberIndex) => {
      allocations.push({
        ...member,
        amount: moneyFromCents(memberCents[memberIndex] ?? 0),
      });
    });
  });
  allocations.sort((a, b) => a.workerId - b.workerId);

  const amounts = allocations.map((allocation) => allocation.amount);
  return {
    extraBales,
    bonusPool,
    allocations,
    perWorkerMin: Math.min(...amounts),
    perWorkerMax: Math.max(...amounts),
    distributable: true,
  };
}
