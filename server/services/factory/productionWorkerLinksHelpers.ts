// Extracted from ./productionWorkerLinks.ts

export interface ProductionWorkerLinkMember {
  workerId: number;
  workerName: string;
}

export interface ProductionWorkerLink {
  id: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  sharedTargetBales: number | null;
  members: ProductionWorkerLinkMember[];
}

export type LinkRow = {
  id: number | string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sharedTargetBales: string | number | null;
  members: unknown;
};

export function parseMembers(value: unknown): ProductionWorkerLinkMember[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((member) => ({
      workerId: Number(member?.workerId),
      workerName: String(member?.workerName ?? ""),
    }))
    .filter((member) => Number.isInteger(member.workerId) && member.workerId > 0)
    .sort((a, b) => a.workerId - b.workerId);
}

export function indexProductionWorkerLinks(links: ProductionWorkerLink[]): Map<number, ProductionWorkerLink> {
  const byWorker = new Map<number, ProductionWorkerLink>();
  for (const link of links) {
    for (const member of link.members) byWorker.set(member.workerId, link);
  }
  return byWorker;
}
