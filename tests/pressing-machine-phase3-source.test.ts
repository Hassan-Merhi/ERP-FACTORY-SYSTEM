import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const scanner = source("client/src/pages/factory/ContinuousPressingScanner.tsx");
const gate = source("client/src/pages/factory/pressing-scanner/continuousScanGate.ts");
const manager = source("client/src/pages/factory/PressingMachineManagement.tsx");
const stockEntry = source("client/src/pages/factory/BaleStockEntry.tsx");

describe("Pressing Machine Phase 3 integration contract", () => {
  it("continues scanning, instead of closing after a barcode read", () => {
    expect(scanner).toContain("setTimeout(() => void tick(detector), SCAN_POLL_MS[detector.engine])");
    expect(scanner).toContain("const SCAN_POLL_MS = { native: 70, zxing: 90 }");
    expect(scanner).toContain("new ContinuousScanGate(1500, 3)");
    expect(scanner).toContain("const next = gateRef.current.frame(value, Date.now())");
    expect(gate).toContain("if (barcode === this.visible) return null");
    expect(scanner).not.toContain("setRequested(false);\n              onBarcode");
  });
  it("stops/restarts video with actual tab visibility and worker assignment", () => {
    expect(scanner).toContain('document.addEventListener("visibilitychange"');
    expect(scanner).toContain("const running = usable && requested && visible");
    expect(scanner).toContain("stream?.getTracks().forEach(track => track.stop())");
    expect(stockEntry).toContain('<PressingMachineManagement active={activeTab === "pressing-machines"} />');
  });
  it("has fallback, safe audio, vibration, torch and device timestamp support", () => {
    expect(scanner).toContain("createCameraDecoder()");
    expect(scanner).toContain('setStatus("manual")');
    expect(scanner).toContain("navigator.vibrate");
    expect(scanner).toContain("applyConstraints");
    expect(scanner).toContain("deviceCapturedAt");
    expect(scanner).toContain('second: "2-digit"');
  });
  it("keeps the Phase 3 camera separate from Factory stock finalization", () => {
    expect(manager).toContain("onBarcode={cameraRead}");
    expect(manager).toContain("Scan bale reference / barcode...");
    expect(scanner).toContain("Server confirmed:");
    expect(scanner).not.toContain("Stock finalization is a separate workflow");
    expect(scanner).not.toContain("The camera stays open between reads.");
    expect(scanner).not.toContain("POST /api/factory/finalize");
  });
});
