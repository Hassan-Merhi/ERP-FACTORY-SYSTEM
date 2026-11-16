import { describe, expect, it } from "vitest";
import { factoryRenameDefaults, LEGACY_FACTORY_RENAME_DEFAULTS } from "../shared/factoryUiDefaults";
import { factoryStatusLabel } from "../shared/factoryStatusPresentation";

describe("Factory Phase 3 typed presentation contracts", () => {
  it("keeps existing legacy code rename defaults without data mutation", () => {
    expect(factoryRenameDefaults()).toEqual(LEGACY_FACTORY_RENAME_DEFAULTS);
    expect(factoryRenameDefaults({ renameCodePrefix: "ABC" }).codePrefix).toBe("ABC");
    expect(factoryRenameDefaults({ renameCodePrefix: "" }).codePrefix).toBe("HMD13");
  });
  it("preserves existing V5 pending-verification label for display parity", () => {
    expect(factoryStatusLabel("allocation", "PENDING_VERIFICATION")).toBe("Verified");
    expect(factoryStatusLabel("allocation", "FINALIZED")).toBe("Finalized");
  });
  it("separates dispatch trip state from allocation state", () => {
    expect(factoryStatusLabel("dispatch", "CLOSED")).toBe("Closed");
    expect(factoryStatusLabel("dispatch", "PENDING_VERIFICATION")).toBe("PENDING_VERIFICATION");
    expect(factoryStatusLabel("allocation", "CLOSED")).toBe("CLOSED");
  });
  it("preserves container and unknown legacy statuses", () => {
    expect(factoryStatusLabel("container", "PARTIALLY_RECEIVED")).toBe("Partially Offloaded");
    expect(factoryStatusLabel("container", "SOME_FUTURE_STATUS")).toBe("SOME_FUTURE_STATUS");
  });
});
