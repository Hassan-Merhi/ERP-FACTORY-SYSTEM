import { describe, expect, it } from "vitest";
import { estimateAisEta, greatCircleDistanceNm } from "../aisEtaEstimator";

describe("AIS ETA estimator", () => {
  it("calculates great-circle distance in nautical miles", () => {
    expect(greatCircleDistanceNm(0, 0, 0, 1)).toBeCloseTo(60.04, 0);
  });

  it("returns a separate low-confidence estimate for a fresh moving vessel", () => {
    const now = new Date("2026-09-21T12:00:00Z");
    const result = estimateAisEta({ latitude: 0, longitude: 0, destinationLatitude: 0, destinationLongitude: 10, speedKnots: 20, lastPositionAt: new Date("2026-09-21T11:30:00Z"), now });
    expect(result.source).toBe("ais_calculated");
    expect(result.confidence).toBe("low");
    expect(result.eta).not.toBeNull();
    expect(result.distanceNm).toBeGreaterThan(590);
  });

  it("refuses stale positions", () => {
    const result = estimateAisEta({ latitude: 0, longitude: 0, destinationLatitude: 0, destinationLongitude: 1, speedKnots: 20, lastPositionAt: new Date("2026-09-20T00:00:00Z"), now: new Date("2026-09-21T12:00:00Z") });
    expect(result.eta).toBeNull();
    expect(result.reason).toContain("stale");
  });

  it("refuses stationary or implausibly fast vessels", () => {
    const base = { latitude: 0, longitude: 0, destinationLatitude: 0, destinationLongitude: 1, lastPositionAt: new Date("2026-09-21T11:30:00Z"), now: new Date("2026-09-21T12:00:00Z") };
    expect(estimateAisEta({ ...base, speedKnots: 0.5 }).eta).toBeNull();
    expect(estimateAisEta({ ...base, speedKnots: 60 }).eta).toBeNull();
  });

  it("refuses to guess when destination coordinates are unavailable", () => {
    const result = estimateAisEta({ latitude: 0, longitude: 0, speedKnots: 20, lastPositionAt: new Date() });
    expect(result.eta).toBeNull();
    expect(result.reason).toContain("Destination coordinates");
  });
});
