import { describe, expect, it } from "vitest";
import { ContinuousScanGate } from "./continuousScanGate";

describe("ContinuousScanGate", () => {
  it("accepts the first barcode and suppresses repeated camera frames", () => {
    const gate = new ContinuousScanGate();
    expect(gate.frame("REF300208", 10000)).toBe("REF300208");
    expect(gate.frame(" REF300208 ", 10220)).toBeNull();
    expect(gate.frame("REF300208", 10880)).toBeNull();
  });

  it("accepts a different bale immediately without closing the camera", () => {
    const gate = new ContinuousScanGate();
    expect(gate.frame("REF300208", 10000)).toBe("REF300208");
    expect(gate.frame("REF300209", 10100)).toBe("REF300209");
    expect(gate.frame("REF300210", 10120)).toBe("REF300210");
  });

  it("requires the old code to leave view and pass cooldown before re-arming", () => {
    const gate = new ContinuousScanGate(3500, 3);
    expect(gate.frame("REF300208", 10000)).toBe("REF300208");
    expect(gate.frame(null, 10200)).toBeNull();
    expect(gate.frame(null, 10400)).toBeNull();
    expect(gate.frame(null, 10600)).toBeNull();
    expect(gate.frame("REF300208", 10700)).toBeNull();
    expect(gate.frame(null, 11000)).toBeNull();
    expect(gate.frame(null, 11200)).toBeNull();
    expect(gate.frame(null, 11400)).toBeNull();
    expect(gate.frame("REF300208", 13600)).toBe("REF300208");
  });

  it("suppresses manual-entry bounces but accepts different codes", () => {
    const gate = new ContinuousScanGate();
    expect(gate.manual("REF300208", 1000)).toBe("REF300208");
    expect(gate.manual("REF300208", 1200)).toBeNull();
    expect(gate.manual("REF300209", 1300)).toBe("REF300209");
    expect(gate.manual(" ", 1400)).toBeNull();
  });

  it("clears camera-only state when the camera is stopped or assignment changes", () => {
    const gate = new ContinuousScanGate();
    expect(gate.frame("REF300208", 1000)).toBe("REF300208");
    gate.reset();
    expect(gate.frame("REF300208", 1001)).toBe("REF300208");
  });
});
