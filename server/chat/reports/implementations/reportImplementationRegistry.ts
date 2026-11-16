import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { phase1ReportShard as financialAndPartyReportShard } from "./financialAndPartyReportShard";
import { phase2ReportShard as inventoryOperationsReportShard } from "./inventoryOperationsReportShard";
import { phase3ReportShard as salesAndAssetsReportShard } from "./salesAndAssetsReportShard";
import { phase4ReportShard as retailAndFactoryReportShard } from "./retailAndFactoryReportShard";
import { phase5ReportShard as accountingDetailReportShard } from "./accountingDetailReportShard";
import { phase6ReportShard as masterDataAndJournalReportShard } from "./masterDataAndJournalReportShard";
import { phase7ReportShard as auditAndTrackingReportShard } from "./auditAndTrackingReportShard";
import { schemaCompatibilityReportShard } from "./schemaCompatibilityReportShard";

export const reportImplementationShards: readonly ReportImplementationShard[] = [
  financialAndPartyReportShard,
  inventoryOperationsReportShard,
  salesAndAssetsReportShard,
  retailAndFactoryReportShard,
  accountingDetailReportShard,
  masterDataAndJournalReportShard,
  auditAndTrackingReportShard,
];

const implementationByQueryType = new Map<string, ReportImplementationShard>();

for (const shard of reportImplementationShards) {
  for (const queryType of shard.queryTypes) {
    const existing = implementationByQueryType.get(queryType);
    if (existing) {
      throw new Error(`Duplicate chat report implementation for ${queryType}: ${existing.name} and ${shard.name}`);
    }
    implementationByQueryType.set(queryType, shard);
  }
}

// Eight legacy report implementations still referenced columns removed or
// renamed by the current schema. Override only those mapped query types with
// their current-schema implementations; all other report routing remains
// unchanged and the public 71-query registry stays stable.
for (const queryType of schemaCompatibilityReportShard.queryTypes) {
  if (!implementationByQueryType.has(queryType)) {
    throw new Error(`Schema compatibility override references unknown report query type: ${queryType}`);
  }
  implementationByQueryType.set(queryType, schemaCompatibilityReportShard);
}

export const implementedReportQueryTypes = Object.freeze([...implementationByQueryType.keys()]);

export function findReportImplementation(queryType: string): ReportImplementationShard | undefined {
  return implementationByQueryType.get(queryType);
}

export async function runReportImplementation(ctx: DataQueryContext): Promise<DataQueryResult> {
  const queryType = typeof ctx.params.queryType === "string" ? ctx.params.queryType : "";
  return implementationByQueryType.get(queryType)?.run(ctx);
}
