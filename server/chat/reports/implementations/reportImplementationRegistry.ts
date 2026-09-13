import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { phase1ReportShard } from "./phase1ReportShard";
import { phase2ReportShard } from "./phase2ReportShard";
import { phase3ReportShard } from "./phase3ReportShard";
import { phase4ReportShard } from "./phase4ReportShard";
import { phase5ReportShard } from "./phase5ReportShard";
import { phase6ReportShard } from "./phase6ReportShard";
import { phase7ReportShard } from "./phase7ReportShard";
import { hasSchemaCompatibleReportOverride, runSchemaCompatibleReportOverride } from "./schemaCompatibleReportOverrides";

export const reportImplementationShards: readonly ReportImplementationShard[] = [
  phase1ReportShard,
  phase2ReportShard,
  phase3ReportShard,
  phase4ReportShard,
  phase5ReportShard,
  phase6ReportShard,
  phase7ReportShard,
];

const implementationByQueryType = new Map<string, ReportImplementationShard>();

for (const shard of reportImplementationShards) {
  for (const queryType of shard.queryTypes) {
    const existing = implementationByQueryType.get(queryType);
    if (existing) {
      throw new Error(
        `Duplicate chat report implementation for ${queryType}: ${existing.name} and ${shard.name}`
      );
    }
    implementationByQueryType.set(queryType, shard);
  }
}

export const implementedReportQueryTypes = Object.freeze([...implementationByQueryType.keys()]);

export function findReportImplementation(queryType: string): ReportImplementationShard | undefined {
  return implementationByQueryType.get(queryType);
}

export async function runReportImplementation(ctx: DataQueryContext): Promise<DataQueryResult> {
  const queryType = typeof ctx.params.queryType === "string" ? ctx.params.queryType : "";
  if (hasSchemaCompatibleReportOverride(queryType)) {
    return runSchemaCompatibleReportOverride(ctx);
  }
  return implementationByQueryType.get(queryType)?.run(ctx);
}
