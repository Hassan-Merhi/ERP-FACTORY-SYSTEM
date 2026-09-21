import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Factory stock-entry print gate", () => {
  it("keeps stock entry locked until both required print tabs are closed", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    for (const token of [
      "printGateActive",
      "printGateReady",
      "printGateNeedsReopen",
      "printGateWindowsRef",
      "window.setInterval(checkPrintTabs, 250)",
      "windows.a4.closed",
      "windows.sticker.closed",
      "closedCount === 2",
      'data-testid="stock-entry-print-lock"',
      "Close both print tabs after printing",
    ]) {
      expect(tab).toContain(token);
    }
  });

  it("does not save a bale when either required popup is blocked", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain("const windows = openRequiredPrintWindows()");
    expect(tab).toContain("if (!windows)");
    expect(tab).toContain("Stock Entry was not saved, so no bale was created.");
    expect(tab.indexOf("if (!windows)")).toBeLessThan(tab.indexOf("stockEntryMutation.mutate()"));
  });

  it("keeps the completed entry locked when print tabs are closed too early", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain("Print tabs closed too early");
    expect(tab).toContain("setPrintGateNeedsReopen(true)");
    expect(tab).toContain("Reopen Print Tabs");
    expect(tab).toContain("runPendingPrintJob(windows)");
  });

  it("disables scanner entry while the print gate is active", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");
    const scanner = source("client/src/pages/factory/bale-stock-entry/StockEntryScanner.tsx");

    expect(tab).toContain("disabled={printGateActive || stockEntryMutation.isPending}");
    expect(tab).toContain("if (printGateActive || !value.trim()) return");
    expect(scanner).toContain("disabled?: boolean");
    expect(scanner).toContain("disabled={disabled}");
    expect(scanner).toContain("if (disabled)");
  });

  it("warns against leaving the page while printing is unfinished", () => {
    const tab = source("client/src/pages/factory/bale-stock-entry/StockEntryTab.tsx");

    expect(tab).toContain('window.addEventListener("beforeunload", warnBeforeLeave)');
    expect(tab).toContain('window.removeEventListener("beforeunload", warnBeforeLeave)');
  });
});
