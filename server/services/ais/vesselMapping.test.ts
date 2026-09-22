import { describe, expect, it } from "vitest";
import { extractVesselIdentity } from "./vesselMapping";

describe("extractVesselIdentity", () => {
  it("extracts explicit current vessel identifiers", () => {
    expect(extractVesselIdentity({ currentVessel: { name: "MAERSK TEST", imo: "IMO 1234567", mmsi: "123456789", voyageNumber: "42W" } })).toEqual({
      name: "MAERSK TEST", imo: "IMO 1234567", mmsi: "123456789", voyage: "42W",
    });
  });

  it("extracts a vessel nested on the first container", () => {
    expect(extractVesselIdentity({ containers: [{ vessel: { vesselName: "TEST SHIP", IMO: 7654321, MMSI: 987654321 } }] })).toEqual({
      name: "TEST SHIP", imo: "7654321", mmsi: "987654321", voyage: null,
    });
  });

  it("does not guess from arbitrary text", () => {
    expect(extractVesselIdentity({ description: "Loaded aboard MAERSK MAYBE" })).toBeNull();
  });
});
