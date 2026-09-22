import { describe, expect, it } from "vitest";
import { normalizeMmsi, parseAisStreamMessage } from "../server/services/ais/aisMessageParser";

describe("AISStream parser", () => {
  it("normalizes valid MMSIs and rejects malformed values", () => {
    expect(normalizeMmsi(636021111)).toBe("636021111");
    expect(normalizeMmsi(" 636021111 ")).toBe("636021111");
    expect(normalizeMmsi("1234")).toBeNull();
  });

  it("parses a position report", () => {
    const result = parseAisStreamMessage(JSON.stringify({
      MetaData: { MMSI: 636021111, ShipName: "TEST VESSEL", time_utc: "2026-09-21T12:00:00Z" },
      Message: { PositionReport: { Latitude: 12.5, Longitude: 55.2, Sog: 16.4, Cog: 271.2, TrueHeading: 270 } },
    }));
    expect(result).toMatchObject({ kind: "position", mmsi: "636021111", latitude: 12.5, longitude: 55.2, speedKnots: 16.4 });
  });

  it("rejects invalid JSON, invalid MMSI and impossible coordinates", () => {
    expect(parseAisStreamMessage("not json")).toBeNull();
    expect(parseAisStreamMessage(JSON.stringify({ MetaData: { MMSI: 1 }, Message: { PositionReport: { Latitude: 1, Longitude: 1 } } }))).toBeNull();
    expect(parseAisStreamMessage(JSON.stringify({ MetaData: { MMSI: 636021111 }, Message: { PositionReport: { Latitude: 91, Longitude: 1 } } }))).toBeNull();
  });
});
