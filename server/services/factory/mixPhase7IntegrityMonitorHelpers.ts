// Extracted from ./mixPhase7IntegrityMonitor.ts
import Decimal from "decimal.js";
import {
  MAX_FINDINGS,
  severityLevel,
  type MixMonitorFinding,
  type StoredMonitorState,
} from "./buildMixMonitorSnapshot";

export function compareMixMonitorFindings(
  previous: StoredMonitorState["findings"] | null,
  current: MixMonitorFinding[]
): { baseline: boolean; newOrEscalated: MixMonitorFinding[]; resolvedKeys: string[] } {
  if (previous === null) return { baseline: true, newOrEscalated: [], resolvedKeys: [] };
  const old = new Map(previous.map((item) => [item.key, item] as const));
  const worsened = (now: MixMonitorFinding, before?: StoredMonitorState["findings"][number]): boolean => {
    if (!now.metric || !before?.metric || now.metric.unit !== before.metric.unit) return false;
    try {
      const tolerance = now.metric.unit === "kg" ? "0.001" : now.metric.unit === "usd" ? "0.02" : "0";
      return new Decimal(now.metric.value).gt(new Decimal(before.metric.value).plus(tolerance));
    } catch {
      return false;
    }
  };
  const present = new Set(current.map((item) => item.key));
  return {
    baseline: false,
    newOrEscalated: current.filter((item) => {
      const prior = old.get(item.key);
      return (
        prior === undefined || severityLevel[item.severity] > severityLevel[prior.severity] || worsened(item, prior)
      );
    }),
    resolvedKeys: previous.map((item) => item.key).filter((key) => !present.has(key)),
  };
}

export function parseState(payload: string | null): StoredMonitorState | null {
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<StoredMonitorState>;
    if (
      v.version !== 1 ||
      !Array.isArray(v.findings) ||
      typeof v.lastSuccessAt !== "string" ||
      !v.summary ||
      v.findings.length > MAX_FINDINGS ||
      !v.findings.every(
        (f) =>
          f &&
          typeof f.key === "string" &&
          (f.severity === "review" || f.severity === "warning" || f.severity === "critical")
      )
    ) {
      return null;
    }
    return v as StoredMonitorState;
  } catch {
    return null;
  }
}

export interface MixMonitorRunResult {
  companyId: number;
  baseline: boolean;
  currentIssues: number;
  alertsCreated: number;
  resolved: number;
  checkedAt: string;
}
