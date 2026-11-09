import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; type: string; entityType: string; entityId: number; isRead: boolean; message: string | null; severity: string }>,
  sql: [] as Array<{ text: string; values: unknown[] }>,
  released: false,
  nextId: 1,
  forceError: false,
}));
vi.mock("../server/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        memory.sql.push({ text: sql, values });
        if (memory.forceError && sql.includes("INSERT INTO factory_alerts")) throw new Error("simulated DB write error");
        if (sql.startsWith("SELECT id, message FROM factory_alerts")) {
          const row = memory.rows.find(r => r.type === "MIX_MONITOR_STATE");
          return { rows: row ? [{ id: row.id, message: row.message }] : [] };
        }
        if (sql.startsWith("INSERT INTO factory_alerts")) {
          const isState = String(values[1]) === "MIX_MONITOR_STATE";
          memory.rows.push({
            id: memory.nextId++, type: String(values[1]), entityType: isState ? "mix_monitor" : String(values[5]),
            entityId: isState ? 0 : Number(values[6]), isRead: isState,
            message: isState ? String(values[2]) : String(values[4]),
            severity: isState ? "info" : String(values[2]),
          });
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE factory_alerts SET message=$1")) {
          const state = memory.rows.find(r => r.id === values[1]);
          if (state) { state.message = String(values[0]); state.isRead = true; }
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE factory_alerts SET is_read=true")) {
          const key = String(values[2]).slice(0, -2);
          for (const row of memory.rows) if (row.type === "MIX_INTEGRITY" &&
            !row.isRead && row.message?.startsWith(key + " ")) row.isRead = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => { memory.released = true; },
    }),
    query: async () => {
      const state = memory.rows.find(r => r.type === "MIX_MONITOR_STATE");
      return { rows: [{
        message: state?.message ?? null,
        unread_alerts: String(memory.rows.filter(r => r.type === "MIX_INTEGRITY" && !r.isRead).length),
      }] };
    },
  },
}));

import {
  buildMixMonitorSnapshot,
  compareMixMonitorFindings,
  persistMixMonitorSnapshot,
  getMixMonitorStatus,
  type MixMonitorFinding,
} from "../server/services/factory/mixPhase7IntegrityMonitor";

const summary = (companyId = 12) => ({
  companyId, generatedAt: "2026-11-09T14:20:00.000Z", readOnly: true,
});
const finding = (key: string, severity: MixMonitorFinding["severity"] = "warning"): MixMonitorFinding => ({
  key, severity, code: "TEST", title: "Test", detail: "Test detail",
  entityType: "mix_batch", entityId: 17,
});

function fixtureReports() {
  const historic = {
    ...summary(),
    batches: [{
      batchId: 231, batchCode: "FMB-2026-0231",
      deleted: false, recordedBlendedUsdPerKg: "0.5747910",
      issues: [
        { code: "CURRENT_SUPPLIER_RATE_CHANGED", severity: "informational", detail: "Supplier rate changed" },
        { code: "CURRENT_SUPPLIER_RATE_MISSING", severity: "informational", detail: "Supplier missing now" },
        { code: "SOURCE_VALUE_MATH_MISMATCH", sourceId: 9, severity: "error", detail: "Source math inconsistent" },
        { code: "COMPLETED_WITH_REMAINDER", severity: "review", detail: "historical" },
      ],
    }],
  };
  const stock = {
    ...summary(),
    rawStockExceptions: [
      { rawStockId: 1, containerNumber: "CT-1", excessUsedKg: "300",
        supplierCoverage: "POTENTIALLY_ADJUSTMENT_BACKED" },
      { rawStockId: 2, containerNumber: "CT-2", excessUsedKg: "400",
        supplierCoverage: "UNBACKED_SHORTAGE" },
    ],
    ownershipExceptions: [{
      sourceId: 3, batchCode: "FMB-2026-0090", recordedInventorySupplierId: 37,
      currentContainerSupplierId: 60, classification: "REQUIRES_HISTORICAL_TRANSFER_PROOF",
    }],
    adjustmentEvidence: [{ adjustmentId: 7, classification: "FX_AND_BASIS_EVIDENCE_REQUIRED",
      supplierName: "Supplier", supplierId: 7, kg: "55", currency: "EUR" }],
  };
  const downstream = { ...summary(), batches: [
    { batchId: 231, batchCode: "FMB-2026-0231", deleted: false,
      classification: "NO_RECORDED_PRODUCTION_LINEAGE", mismatchedLinkedBales: 0 },
    { batchId: 222, batchCode: "FMB-2026-0222", deleted: false,
      classification: "LINKED_BALE_COST_MISMATCH", mismatchedLinkedBales: 2 },
  ] };
  const lifecycle = { ...summary(), batches: [
    { batchId: 50, batchCode: "FMB-2026-0035", deleted: false,
      usedKg: "7084.000", totalKg: "7067.000", issues: [
        { code: "OVERUSED", severity: "error", detail: "Excess 17 kg" },
      ] },
    { batchId: 231, batchCode: "FMB-2026-0231", deleted: false,
      usedKg: "12000.000", totalKg: "15353.000", issues: [
        { code: "COMPLETED_WITH_REMAINDER", severity: "review", detail: "Old incomplete record" },
      ] },
  ] };
  return { historic, stock, downstream, lifecycle };
}

describe("Phase 7 Factory mix integrity classification", () => {
  it("suppresses current supplier-rate drift and distinguishes proven critical issues", () => {
    const { historic, stock, downstream, lifecycle } = fixtureReports();
    const monitor = buildMixMonitorSnapshot(12, historic as never, stock as never, downstream as never, lifecycle as never);
    expect(monitor.summary.suppressedCurrentRateDrift).toBe(true);
    expect(monitor.findings.some(f => f.code.startsWith("CURRENT_SUPPLIER_RATE"))).toBe(false);
    expect(monitor.findings.some(f => f.code === "NO_RECORDED_PRODUCTION_LINEAGE")).toBe(false);
    expect(monitor.findings.find(f => f.code === "SOURCE_VALUE_MATH_MISMATCH")?.severity).toBe("critical");
    expect(monitor.findings.find(f => f.code === "OVERUSED")?.severity).toBe("critical");
    expect(monitor.findings.find(f => f.code === "UNBACKED_SHORTAGE")?.severity).toBe("critical");
    expect(monitor.findings.find(f => f.code === "ADJUSTMENT_BACKED_OVERDRAW_REVIEW")?.severity).toBe("review");
    expect(monitor.findings.find(f => f.code === "LINKED_BALE_COST_MISMATCH")?.severity).toBe("critical");
    expect(monitor.findings.filter(f => f.code === "COMPLETED_WITH_REMAINDER")).toHaveLength(1);
  });

  it("refuses company-contaminated source reports before emitting alerts", () => {
    const { historic, stock, downstream, lifecycle } = fixtureReports();
    expect(() => buildMixMonitorSnapshot(12, historic as never, {
      ...stock, companyId: 17,
    } as never, downstream as never, lifecycle as never)).toThrow("cross-tenant");
  });

  it("first run establishes a baseline, second unchanged run produces no alerts", () => {
    const f = finding("mix:17:HEADER_SOURCE_WEIGHT_MISMATCH", "critical");
    expect(compareMixMonitorFindings(null, [f])).toEqual({
      baseline: true, newOrEscalated: [], resolvedKeys: [],
    });
    expect(compareMixMonitorFindings([{ key: f.key, severity: f.severity }], [f]).newOrEscalated).toEqual([]);
  });

  it("new and higher-severity issues alert; de-escalations do not", () => {
    const previous = [
      { key: "mix:17:RATE", severity: "warning" as const },
      { key: "mix:18:VALUE", severity: "critical" as const },
      { key: "raw:19:OVER", severity: "review" as const },
    ];
    const current = [
      finding("mix:17:RATE", "critical"),
      finding("mix:18:VALUE", "warning"),
      finding("mix:20:NEW", "warning"),
    ];
    const compared = compareMixMonitorFindings(previous, current);
    expect(compared.baseline).toBe(false);
    expect(compared.newOrEscalated.map(f => f.key)).toEqual(["mix:17:RATE", "mix:20:NEW"]);
    expect(compared.resolvedKeys).toEqual(["raw:19:OVER"]);
  });
});

describe("Phase 7 durable monitor state and alert changes", () => {
  beforeEach(() => {
    memory.rows = []; memory.sql = []; memory.released = false;
    memory.nextId = 1; memory.forceError = false;
  });
  const snapshot = (findings: MixMonitorFinding[], time = "2026-11-09T14:20:00.000Z") => ({
    companyId: 12, generatedAt: time, findings,
    summary: {
      critical: findings.filter(f => f.severity === "critical").length,
      warning: findings.filter(f => f.severity === "warning").length,
      review: findings.filter(f => f.severity === "review").length,
      total: findings.length, suppressedCurrentRateDrift: true,
    },
  });

  it("writes only monitoring state on baseline; no historical issue alerts", async () => {
    const report = await persistMixMonitorSnapshot(snapshot([finding("mix:17:OLD", "critical")]));
    expect(report.baseline).toBe(true);
    expect(report.alertsCreated).toBe(0);
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0].type).toBe("MIX_MONITOR_STATE");
    expect(memory.rows[0].isRead).toBe(true);
    expect(memory.sql.some(s => s.text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(memory.sql.at(-1)?.text).toBe("COMMIT");
    expect(memory.released).toBe(true);
  });

  it("creates one Factory alert for each new issue and never repeats unchanged findings", async () => {
    const old = finding("mix:17:OLD", "critical");
    const fresh = finding("mix:18:NEW", "warning");
    await persistMixMonitorSnapshot(snapshot([old]));
    const changed = await persistMixMonitorSnapshot(snapshot([old, fresh], "2026-11-10T01:35:00.000Z"));
    expect(changed.alertsCreated).toBe(1);
    const again = await persistMixMonitorSnapshot(snapshot([old, fresh], "2026-11-11T01:35:00.000Z"));
    expect(again.alertsCreated).toBe(0);
    expect(memory.rows.filter(r => r.type === "MIX_INTEGRITY")).toHaveLength(1);
    const status = await getMixMonitorStatus(12);
    expect(status.unreadAlerts).toBe(1);
    expect(status.initialized).toBe(true);
    expect(status.summary?.total).toBe(2);
  });

  it("clears only a resolved monitor alert, preserving unrelated alert types", async () => {
    const base = finding("mix:17:OLD", "critical");
    const extra = finding("mix:18:NEW", "critical");
    await persistMixMonitorSnapshot(snapshot([base]));
    await persistMixMonitorSnapshot(snapshot([base, extra]));
    memory.rows.push({
      id: memory.nextId++, type: "MISSING_DOCS", severity: "warning", entityId: 12,
      entityType: "container", isRead: false, message: "Missing docs",
    });
    const result = await persistMixMonitorSnapshot(snapshot([base]));
    expect(result.resolved).toBe(1);
    expect(memory.rows.find(r => r.type === "MIX_INTEGRITY")?.isRead).toBe(true);
    expect(memory.rows.find(r => r.type === "MISSING_DOCS")?.isRead).toBe(false);
  });

  it("rolls back on an alert write failure without claiming a successful scan", async () => {
    await persistMixMonitorSnapshot(snapshot([]));
    memory.sql = []; memory.released = false; memory.forceError = true;
    await expect(persistMixMonitorSnapshot(snapshot([finding("mix:17:NEW")]))).rejects.toThrow("simulated");
    expect(memory.sql.at(-1)?.text).toBe("ROLLBACK");
    expect(memory.released).toBe(true);
  });
});
