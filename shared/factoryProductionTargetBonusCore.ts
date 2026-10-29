import Decimal from "decimal.js";

export type ProductionBonusScope = "company" | "worker";
export type ProductionBonusStatus = "Present" | "Absent" | "New";

export interface ProductionTargetBonusRate {
  id: number;
  scope: ProductionBonusScope;
  workerId: number | null;
  effectiveFrom: string;
  enabled: boolean;
  ratePerExtraBale: string;
}

export interface ProductionTargetBonusWorker {
  workerId: number;
  workerName: string;
  employeeCode: string | null;
  category: string | null;
  status: ProductionBonusStatus;
  targetBales: number | null;
  // The finalized daily snapshot repeats the entire team total for each
  // linked member. Never add these repeated values together.
  producedBales: number | null;
}

export interface ProductionTargetBonusLink {
  id: number;
  workerIds: number[];
}

export interface ProductionTargetBonusDayInput {
  date: string;
  finalized: boolean;
  workers: ProductionTargetBonusWorker[];
  links: ProductionTargetBonusLink[];
}

export type ProductionTargetBonusIssue =
  | "NOT_FINALIZED"
  | "INVALID_PRODUCTION"
  | "LINK_MEMBER_MISSING"
  | "OVERLAPPING_LINKS"
  | "LINKED_OUTPUT_CONFLICT"
  | "NO_TARGET"
  | "ABSENT"
  | "RATE_DISABLED"
  | "NO_RATE"
  | "ODD_LINKED_BALES";

export interface ProductionTargetBonusWorkerPreview {
  date: string;
  workerId: number;
  workerName: string;
  employeeCode: string | null;
  category: string | null;
  status: ProductionBonusStatus;
  linkGroupId: number | null;
  partnerIds: number[];
  targetBales: number | null;
  // Credited share, not the repeated team total.
  creditedBales: number;
  extraBales: number;
  ratePerExtraBale: string;
  rateVersionId: number | null;
  rateScope: ProductionBonusScope | null;
  bonusUsd: string;
  eligibleForReview: boolean;
  requiresReview: boolean;
  issues: ProductionTargetBonusIssue[];
}

export interface ProductionTargetBonusDayPreview {
  date: string;
  finalized: boolean;
  payoutReady: boolean;
  totalProducedBales: number;
  extraBales: number;
  proposedBonusUsd: string;
  workers: ProductionTargetBonusWorkerPreview[];
  warnings: ProductionTargetBonusIssue[];
}

function validBales(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function sumUsd(amounts: string[]): string {
  return amounts.reduce((total, amount) => total.plus(amount), new Decimal(0)).toFixed(2);
}

/** Choose the most recent dated version, then the newest saved version of that day. */
export function resolveProductionTargetBonusRate(
  workerId: number,
  date: string,
  versions: ProductionTargetBonusRate[],
): ProductionTargetBonusRate | null {
  const eligible = versions.filter(
    (version) =>
      version.effectiveFrom <= date &&
      (version.scope === "company" || (version.scope === "worker" && version.workerId === workerId)),
  );
  const sortNewest = (a: ProductionTargetBonusRate, b: ProductionTargetBonusRate) =>
    b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id;
  // An explicit worker setting overrides the company default, even if the
  // company rate was edited more recently; inherit only when no worker rule exists.
  return (
    eligible.filter((version) => version.scope === "worker").sort(sortNewest)[0] ??
    eligible.filter((version) => version.scope === "company").sort(sortNewest)[0] ??
    null
  );
}

function groupBales(
  workers: ProductionTargetBonusWorker[],
  links: ProductionTargetBonusLink[],
): {
  shares: Map<number, { credited: number; linkId: number | null; partnerIds: number[]; issues: ProductionTargetBonusIssue[] }>;
  produced: number;
  warnings: ProductionTargetBonusIssue[];
} {
  const shares = new Map<number, { credited: number; linkId: number | null; partnerIds: number[]; issues: ProductionTargetBonusIssue[] }>();
  const warnings: ProductionTargetBonusIssue[] = [];
  const byId = new Map(workers.map((worker) => [worker.workerId, worker]));
  const linkedWorkers = new Set<number>();
  let produced = 0;

  const memberships = new Map<number, number>();
  const conflictIds = new Set<number>();
  for (const link of links) {
    for (const id of new Set(link.workerIds)) {
      if (memberships.has(id)) conflictIds.add(id);
      memberships.set(id, link.id);
    }
  }
  if (conflictIds.size) warnings.push("OVERLAPPING_LINKS");

  for (const link of links) {
    const ids = [...new Set(link.workerIds)].sort((a, b) => a - b);
    if (!ids.length) continue;
    const members = ids.map((id) => byId.get(id));
    const invalidGroup = ids.some((id) => conflictIds.has(id)) || members.some((member) => !member);
    const exists = members.filter((member): member is ProductionTargetBonusWorker => Boolean(member));
    for (const member of exists) linkedWorkers.add(member.workerId);

    const counts = exists.map((member) => member.producedBales);
    const consistent = counts.every((count) => validBales(count) && count === counts[0]);
    const groupIssues: ProductionTargetBonusIssue[] = [];
    if (members.some((member) => !member)) groupIssues.push("LINK_MEMBER_MISSING");
    if (ids.some((id) => conflictIds.has(id))) groupIssues.push("OVERLAPPING_LINKS");
    if (!consistent) groupIssues.push("LINKED_OUTPUT_CONFLICT");
    const teamProduced = !invalidGroup && consistent ? (counts[0] ?? 0) : 0;
    produced += teamProduced;
    // Absence does not transfer credit to an absent worker. If nobody is
    // present, mark the whole team for review instead of attributing output.
    const recipients = exists.filter((member) => member.status !== "Absent").sort((a, b) => a.workerId - b.workerId);
    if (!recipients.length && teamProduced > 0) groupIssues.push("ABSENT");
    const credits = new Map<number, number>();
    if (!groupIssues.length || (groupIssues.length === 0 && recipients.length)) {
      const each = Math.floor(teamProduced / recipients.length);
      const remainder = teamProduced % recipients.length;
      recipients.forEach((member, index) => credits.set(member.workerId, each + (index < remainder ? 1 : 0)));
      if (remainder > 0) groupIssues.push("ODD_LINKED_BALES");
    }
    for (const member of exists) {
      shares.set(member.workerId, {
        credited: credits.get(member.workerId) ?? 0,
        linkId: link.id,
        partnerIds: ids.filter((id) => id !== member.workerId),
        issues: [...groupIssues],
      });
    }
    warnings.push(...groupIssues);
  }

  for (const worker of workers) {
    if (linkedWorkers.has(worker.workerId)) continue;
    const valid = validBales(worker.producedBales);
    if (!valid) warnings.push("INVALID_PRODUCTION");
    const credited = valid ? worker.producedBales! : 0;
    produced += credited;
    shares.set(worker.workerId, {
      credited,
      linkId: null,
      partnerIds: [],
      issues: valid ? [] : ["INVALID_PRODUCTION"],
    });
  }
  return { shares, produced, warnings: [...new Set(warnings)] };
}

/**
 * Read-only calculation; this function never approves, accrues, pays or posts.
 * A finalized daily snapshot is required before a dollar amount can be
 * eligible. A per-worker target of 0 or null means no bonus target.
 */
export function calculateProductionTargetBonusDay(
  day: ProductionTargetBonusDayInput,
  versions: ProductionTargetBonusRate[],
): ProductionTargetBonusDayPreview {
  const grouped = groupBales(day.workers, day.links);
  const previews = day.workers.map((worker): ProductionTargetBonusWorkerPreview => {
    const share = grouped.shares.get(worker.workerId);
    const rate = resolveProductionTargetBonusRate(worker.workerId, day.date, versions);
    const issues = [...(share?.issues ?? [])];
    if (!day.finalized) issues.push("NOT_FINALIZED");
    if (!validBales(worker.targetBales) || worker.targetBales === 0) issues.push("NO_TARGET");
    if (worker.status === "Absent") issues.push("ABSENT");
    if (!rate?.enabled) issues.push("RATE_DISABLED");
    else if (!new Decimal(rate.ratePerExtraBale).greaterThan(0)) issues.push("NO_RATE");

    const credited = share?.credited ?? 0;
    const extra = validBales(worker.targetBales) && worker.targetBales > 0
      ? Math.max(0, credited - worker.targetBales)
      : 0;
    const blocking = issues.some((issue) => issue !== "ODD_LINKED_BALES");
    const bonusUsd = blocking ? "0.00" : new Decimal(rate!.ratePerExtraBale)
      .times(extra)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);

    return {
      date: day.date,
      workerId: worker.workerId,
      workerName: worker.workerName,
      employeeCode: worker.employeeCode,
      category: worker.category,
      status: worker.status,
      linkGroupId: share?.linkId ?? null,
      partnerIds: share?.partnerIds ?? [],
      targetBales: worker.targetBales,
      creditedBales: credited,
      extraBales: extra,
      ratePerExtraBale: rate?.ratePerExtraBale ?? "0",
      rateVersionId: rate?.id ?? null,
      rateScope: rate?.scope ?? null,
      bonusUsd,
      eligibleForReview: !blocking && extra > 0,
      requiresReview: issues.includes("ODD_LINKED_BALES"),
      issues: [...new Set(issues)],
    };
  });

  const warnings = [...new Set([
    ...grouped.warnings,
    ...(!day.finalized ? ["NOT_FINALIZED" as const] : []),
  ])];
  // If the source is incomplete or ambiguous, do not let approval/posting
  // proceed on that day until a supervisor reconciles the evidence.
  const payoutReady = day.finalized && !warnings.some(
    (issue) => issue !== "ODD_LINKED_BALES",
  );

  return {
    date: day.date,
    finalized: day.finalized,
    payoutReady,
    totalProducedBales: grouped.produced,
    extraBales: previews.reduce((sum, worker) => sum + (worker.eligibleForReview ? worker.extraBales : 0), 0),
    proposedBonusUsd: sumUsd(previews.map((worker) => worker.bonusUsd)),
    workers: previews.sort((a, b) => a.workerName.localeCompare(b.workerName) || a.workerId - b.workerId),
    warnings,
  };
}

export function summarizeProductionTargetBonusDays(days: ProductionTargetBonusDayPreview[]) {
  const map = new Map<number, {
    workerId: number;
    workerName: string;
    employeeCode: string | null;
    targetBales: number;
    creditedBales: number;
    extraBales: number;
    proposedBonusUsd: string;
    eligibleDays: number;
    reviewDays: number;
  }>();
  for (const day of days) for (const worker of day.workers) {
    const item = map.get(worker.workerId) ?? {
      workerId: worker.workerId,
      workerName: worker.workerName,
      employeeCode: worker.employeeCode,
      targetBales: 0,
      creditedBales: 0,
      extraBales: 0,
      proposedBonusUsd: "0.00",
      eligibleDays: 0,
      reviewDays: 0,
    };
    item.targetBales += worker.targetBales ?? 0;
    item.creditedBales += worker.creditedBales;
    item.extraBales += worker.eligibleForReview ? worker.extraBales : 0;
    item.proposedBonusUsd = new Decimal(item.proposedBonusUsd).plus(worker.bonusUsd).toFixed(2);
    item.eligibleDays += worker.eligibleForReview ? 1 : 0;
    item.reviewDays += worker.requiresReview ? 1 : 0;
    map.set(worker.workerId, item);
  }
  return [...map.values()].sort((a, b) => a.workerName.localeCompare(b.workerName));
}
