import { describe, expect, it } from "vitest";
import { factoryLocalDate, factoryLocalDateFromInstant, factoryPastCalendarDates } from "../shared/factoryLocalDate";
import { factoryCameraErrorMessage } from "../client/src/factory/scanner/cameraUiErrors";
import { ContinuousScanGate } from "../client/src/pages/factory/pressing-scanner/continuousScanGate";

describe("Factory Phase 5 Beirut calendar", () => {
  it("handles calendar midnight independent of UTC and across DST", () => {
    expect(factoryLocalDate(new Date("2026-07-01T21:30:00Z"))).toBe("2026-07-02");
    expect(factoryLocalDate(new Date("2026-01-01T21:30:00Z"))).toBe("2026-01-01");
    expect(factoryLocalDate(new Date("2026-01-01T22:30:00Z"))).toBe("2026-01-02");
  });
  it("rejects invalid instants for display and deduplicates past dates", () => {
    expect(factoryLocalDateFromInstant("not-a-date")).toBeNull();
    expect(factoryPastCalendarDates(["2026-11-07", "2026-11-07", "2026-11-09", "2026-11-10"], "2026-11-09")).toEqual(["2026-11-07"]);
  });
});

describe("Factory Phase 5 scanner UI primitives", () => {
  it("maps camera permission and hardware errors without transport effects", () => {
    expect(factoryCameraErrorMessage({ name: "NotAllowedError" })).toMatch(/permission denied/i);
    expect(factoryCameraErrorMessage({ name: "NotReadableError" })).toMatch(/already in use/i);
    expect(factoryCameraErrorMessage(new Error("unavailable"))).toBe("unavailable");
  });
  it("suppresses duplicate frames but accepts a different barcode immediately", () => {
    const gate = new ContinuousScanGate(1200, 2);
    expect(gate.frame("A", 1000)).toBe("A");
    expect(gate.frame("A", 1020)).toBeNull();
    expect(gate.frame("B", 1030)).toBe("B");
    gate.frame(null, 1040);
    gate.frame(null, 1050);
    expect(gate.frame("A", 1060)).toBeNull();
    expect(gate.frame("A", 2300)).toBeNull(); // still continuously visible
    gate.suspend();
    expect(gate.frame("A", 2400)).toBe("A");
  });
});
