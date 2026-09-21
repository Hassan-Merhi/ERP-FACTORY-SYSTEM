import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

// Guard page-level polling sites against steady hidden-tab background traffic.
const pollingCases = [
  ["client/src/pages/dashboard/useDashboard.ts", "visibleTabInterval(5 * 60_000)", "refetchInterval: 300000"],
  ["client/src/pages/pos/hooks/usePosQueries.ts", "visibleTabInterval(60_000)", "refetchInterval: 60_000,"],
  ["client/src/pages/ConflictCenter.tsx", "visibleTabInterval(60_000)", "refetchInterval: 15_000,"],
  ["client/src/pages/settings/ExportCenter.tsx", "visibleTabInterval(60_000)", "refetchInterval: 60000,"],
  ["client/src/pages/settings/DailyExportSection.tsx", "visibleTabInterval(60_000)", "refetchInterval: 60000,"],
  ["client/src/pages/settings/ActiveUsersSection.tsx", "visibleTabInterval(30_000)", "refetchInterval: 30000,"],
  ["client/src/pages/settings/WatchUserDialog.tsx", "visibleTabInterval(30_000)", "refetchInterval: 30000,"],
  ["client/src/pages/settings/RemoteSupportWatchDialog.tsx", "visibleTabInterval(4_000)", "refetchInterval: 4000,"],
  [
    "client/src/pages/factory/FactoryNetPosition.tsx",
    "visibleTabInterval(120_000)",
    "refetchInterval: isToday ? 30_000 : false",
  ],
  ["client/src/pages/factory/FactoryDispatchBatchScan.tsx", "visibleTabInterval(10_000)", "refetchInterval: 10_000,"],
  ["client/src/pages/factory/FactoryPendingLoadings.tsx", "visibleTabInterval(60_000)", "refetchInterval: 60000,"],
  [
    "client/src/pages/properties/PropertiesDashboard.tsx",
    "visibleTabInterval(5 * 60_000)",
    "refetchInterval: 5 * 60 * 1000,",
  ],
  ["client/src/pages/factory/FactoryInvoiceLoadingScan.tsx", "visibleTabInterval(10_000)", "refetchInterval: 10_000,"],
  ["client/src/pages/factory/FactoryDispatchBatchDetail.tsx", "visibleTabInterval(15_000)", "refetchInterval: 15_000,"],
  [
    "client/src/pages/transactionjournal/useTransactionJournalModel.ts",
    "visibleTabInterval(120_000)",
    "refetchInterval: 30_000,",
  ],
  [
    "client/src/pages/factory/factoryfinancialsnapshot/useFactoryFinancialSnapshotModel.ts",
    "visibleTabInterval(5 * 60_000)",
    "refetchInterval: 5 * 60 * 1000,",
  ],
  [
    "client/src/pages/factory/factorystockallocationv3/components/ScanningPanel.tsx",
    "visibleTabInterval(30_000)",
    "refetchInterval: 30000,",
  ],
  [
    "client/src/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel.ts",
    "visibleTabInterval(30_000)",
    "refetchInterval: 30000,",
  ],
] as const;

describe("Performance Wave 1 request-churn policy", () => {
  it.each(pollingCases)("%s uses a hidden-tab-aware polling fallback", (file, expected, forbidden) => {
    const text = source(file);
    expect(text).toContain(expected);
    expect(text).not.toContain(forbidden);
  });

  it("pauses AI task polling when the tab is hidden", () => {
    const text = source("client/src/pages/AICommandCenter.tsx");
    expect(text).toContain('document.visibilityState === "hidden"');
    expect(text).toContain("? 2_000 : false");
    expect(text).not.toContain("? 2000 : false");
  });

  it("pauses container bulk-progress requests while the tab is hidden", () => {
    const text = source("client/src/pages/git-containers/useGITContainersData.ts");
    expect(text).toContain('document.visibilityState === "hidden"');
    expect(text).toContain('fetch("/api/container-tracking/bulk-progress"');
  });

  it("keeps the shared visible-tab helper as the single background-polling gate", () => {
    const text = source("client/src/lib/queryPolicies.ts");
    expect(text).toContain('document.visibilityState === "hidden"');
    expect(text).toContain("return false;");
    expect(text).toContain("refetchInterval: visibleTabInterval(intervalMs)");
    expect(text).toContain("refetchIntervalInBackground: false");
  });
});
