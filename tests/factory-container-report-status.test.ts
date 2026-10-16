import { describe, expect, it } from "vitest";
import { factoryReportStatus, isFactoryReportContainer } from "../client/src/pages/analyticslegacy/components/factoryContainerReportStatus";

describe("Factory Analytics container report status presentation", () => {
  it("groups partial receipts and completed offloads under Offloaded", () => {
    expect(factoryReportStatus("PARTIALLY_RECEIVED")).toBe("Offloaded");
    expect(factoryReportStatus("OFFLOADED")).toBe("Offloaded");
    const rawStatuses = ["PARTIALLY_RECEIVED", "OFFLOADED", "PENDING"];
    expect([...new Set(rawStatuses.map(factoryReportStatus))].sort()).toEqual(["OTW", "Offloaded"]);
  });

  it("labels Pending as OTW in both the status dropdown and report rows", () => {
    expect(factoryReportStatus("PENDING")).toBe("OTW");
    expect(factoryReportStatus("IN_TRANSIT")).toBe("IN TRANSIT");
    const rows = ["PENDING", "OFFLOADED", "PARTIALLY_RECEIVED"];
    expect(rows.filter((status) => factoryReportStatus(status) === "OTW")).toEqual(["PENDING"]);
    expect(rows.filter((status) => factoryReportStatus(status) === "Offloaded")).toHaveLength(2);
  });

  it("excludes opening balances without altering stored statuses", () => {
    expect(isFactoryReportContainer("OPENING_BALANCE")).toBe(false);
    expect(isFactoryReportContainer("opening balance")).toBe(false);
    expect(isFactoryReportContainer("OFFLOADED")).toBe(true);
    expect(isFactoryReportContainer("PARTIALLY_RECEIVED")).toBe(true);
    expect(isFactoryReportContainer("PENDING")).toBe(true);
  });
});
