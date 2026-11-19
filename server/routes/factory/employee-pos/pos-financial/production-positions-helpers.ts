// Extracted from ./production-positions.ts
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "../../../../db";
import {
  factoryProductionPositions,
  factoryProductionPositionRules,
  factoryProductionPositionMemberships,
  factoryWorkers,
} from "@shared/schema";

export type ProductionPositionRuleValues = {
  targetBales: number;
  bonusPerExtraBale: string;
  bonusEnabled: boolean;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function getPositionState(companyId: number, positionId: number, asOf: string) {
  const [position] = await db
    .select()
    .from(factoryProductionPositions)
    .where(and(eq(factoryProductionPositions.companyId, companyId), eq(factoryProductionPositions.id, positionId)))
    .limit(1);
  if (!position) return null;

  const [rule] = await db
    .select()
    .from(factoryProductionPositionRules)
    .where(
      and(
        eq(factoryProductionPositionRules.companyId, companyId),
        eq(factoryProductionPositionRules.positionId, positionId),
        lte(factoryProductionPositionRules.effectiveFrom, asOf),
        or(isNull(factoryProductionPositionRules.effectiveTo), gt(factoryProductionPositionRules.effectiveTo, asOf))
      )
    )
    .orderBy(desc(factoryProductionPositionRules.effectiveFrom))
    .limit(1);

  const members = await db
    .select({
      membershipId: factoryProductionPositionMemberships.id,
      workerId: factoryProductionPositionMemberships.workerId,
      effectiveFrom: factoryProductionPositionMemberships.effectiveFrom,
      effectiveTo: factoryProductionPositionMemberships.effectiveTo,
      fullName: factoryWorkers.fullName,
      employeeCode: factoryWorkers.employeeCode,
      workerActive: factoryWorkers.active,
    })
    .from(factoryProductionPositionMemberships)
    .innerJoin(factoryWorkers, eq(factoryWorkers.id, factoryProductionPositionMemberships.workerId))
    .where(
      and(
        eq(factoryProductionPositionMemberships.companyId, companyId),
        eq(factoryProductionPositionMemberships.positionId, positionId),
        lte(factoryProductionPositionMemberships.effectiveFrom, asOf),
        or(
          isNull(factoryProductionPositionMemberships.effectiveTo),
          gt(factoryProductionPositionMemberships.effectiveTo, asOf)
        )
      )
    )
    .orderBy(asc(factoryWorkers.fullName));

  return {
    ...position,
    targetBales: rule?.targetBales ?? 0,
    bonusPerExtraBale: rule?.bonusPerExtraBale ?? "0",
    bonusEnabled: rule?.bonusEnabled ?? false,
    ruleEffectiveFrom: rule?.effectiveFrom ?? null,
    ruleEffectiveTo: rule?.effectiveTo ?? null,
    workerIds: members.map((m) => m.workerId),
    members,
  };
}

export async function replaceMemberships(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  positionId: number,
  effectiveFrom: string,
  workerIds: number[],
  createdBy: string
) {
  const activeRows = await tx
    .select()
    .from(factoryProductionPositionMemberships)
    .where(
      and(
        eq(factoryProductionPositionMemberships.companyId, companyId),
        eq(factoryProductionPositionMemberships.positionId, positionId),
        isNull(factoryProductionPositionMemberships.effectiveTo)
      )
    );
  const desired = new Set(workerIds);
  for (const row of activeRows) {
    if (desired.has(row.workerId)) continue;
    if (effectiveFrom < row.effectiveFrom) throw new Error("Effective date cannot precede an active membership start");
    await tx
      .update(factoryProductionPositionMemberships)
      .set({ effectiveTo: effectiveFrom, updatedAt: new Date() })
      .where(eq(factoryProductionPositionMemberships.id, row.id));
  }
  const currentIds = new Set(
    activeRows.filter((r: { workerId: number }) => desired.has(r.workerId)).map((r) => r.workerId)
  );
  const toAdd = workerIds.filter((id) => !currentIds.has(id));
  if (toAdd.length) {
    await tx
      .insert(factoryProductionPositionMemberships)
      .values(
        toAdd.map((workerId) => ({ companyId, positionId, workerId, effectiveFrom, effectiveTo: null, createdBy }))
      );
  }
}
