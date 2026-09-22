import { describe, expect, it } from "vitest";
import { normalizeMmsi, parseAisStreamMessage } from "../aisMessageParser";

function position(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    MetaData: { MMSI: 123456789, ShipName: "TEST VESSEL", time_utc: "2026-09-21T12:00:00Z" },
    Message: { PositionReport: { Latitude: 10, Longitude: 20, Sog: 12, Cog: 180, ...overrides } },
  });
}

describe("AIS production input hardening", () => {
  it("accepts only nine-digit MMSIs", () => {
    expect(normalizeMmsi("123456789")).toBe("123456789");
    expect(normalizeMmsi("123")).toBeNull();
    expect(normalizeMmsi("12345678x")).toBeNull();
  });

  it("rejects malformed JSON and unsupported message families", () => {
    expect(parseAisStreamMessage("not-json")).toBeNull();
    expect(parseAisStreamMessage(JSON.stringify({ MetaData: { MMSI: 123456789 }, Message: { Unknown: {} } }))).toBeNull();
  });

  it("rejects coordinates outside geographic bounds", () => {
    expect(parseAisStreamMessage(position({ Latitude: 91 }))).toBeNull();
    expect(parseAisStreamMessage(position({ Longitude: -181 }))).toBeNull();
  });

  it("normalizes a valid position without exposing transport metadata", () => {
    const parsed = parseAisStreamMessage(position());
    expect(parsed?.kind).toBe("position");
    expect(parsed?.mmsi).toBe("123456789");
    if (parsed?.kind === "position") {
      expect(parsed.latitude).toBe(10);
      expect(parsed.longitude).toBe(20);
      expect(parsed.speedKnots).toBe(12);
    }
  });
});
