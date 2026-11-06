/**
 * AISStream message parsing across both casing styles: subscription
 * confirmations, MMSI normalisation, position reports with metadata
 * fallbacks and range checks, and static ship data with IMO and ETA.
 */
import { describe, expect, it } from "vitest";
import {
  isAisStreamSubscriptionConfirmation,
  normalizeMmsi,
  parseAisStreamMessage,
} from "../server/services/ais/aisMessageParser";

const msg = (body: unknown) => JSON.stringify(body);

describe("subscription confirmation and MMSI", () => {
  it("recognises a confirmation in either casing, from a string or a buffer", () => {
    expect(isAisStreamSubscriptionConfirmation(msg({ MessageType: "SubscriptionConfirmation" }))).toBe(true);
    expect(isAisStreamSubscriptionConfirmation(Buffer.from(msg({ messageType: "SubscriptionConfirmation" })))).toBe(
      true
    );
    expect(isAisStreamSubscriptionConfirmation(msg({ MessageType: "PositionReport" }))).toBe(false);
    expect(isAisStreamSubscriptionConfirmation("not json")).toBe(false);
    expect(isAisStreamSubscriptionConfirmation(msg([1, 2]))).toBe(false);
    expect(isAisStreamSubscriptionConfirmation("null")).toBe(false);
  });

  it("accepts exactly nine digits", () => {
    expect(normalizeMmsi(366123456.9)).toBe("366123456");
    expect(normalizeMmsi(" 366123456 ")).toBe("366123456");
    expect(normalizeMmsi("36612345")).toBeNull();
    expect(normalizeMmsi("3661234567")).toBeNull();
    expect(normalizeMmsi(null)).toBeNull();
  });
});

describe("parseAisStreamMessage", () => {
  it("ignores unparseable, message-less and MMSI-less input", () => {
    expect(parseAisStreamMessage("{")).toBeNull();
    expect(parseAisStreamMessage(msg({ MetaData: { MMSI: 366123456 } }))).toBeNull();
    expect(parseAisStreamMessage(msg({ Message: { PositionReport: {} } }))).toBeNull();
    expect(parseAisStreamMessage(msg({ MetaData: { MMSI: 12 }, Message: { PositionReport: {} } }))).toBeNull();
    expect(parseAisStreamMessage(msg({ MetaData: { MMSI: 366123456 }, Message: { Other: {} } }))).toBeNull();
  });

  it("reads a PascalCase position report", () => {
    expect(
      parseAisStreamMessage(
        msg({
          MetaData: { MMSI: 366123456, ShipName: " EVER GIVEN ", time_utc: "2026-10-20T10:00:00Z" },
          Message: {
            PositionReport: {
              Latitude: -33.9,
              Longitude: 18.4,
              Sog: 12.5,
              Cog: "270",
              TrueHeading: 268,
              NavigationalStatus: "UnderWayUsingEngine",
            },
          },
        })
      )
    ).toEqual({
      kind: "position",
      mmsi: "366123456",
      vesselName: "EVER GIVEN",
      latitude: -33.9,
      longitude: 18.4,
      speedKnots: 12.5,
      course: 270,
      heading: 268,
      navigationStatus: "UnderWayUsingEngine",
      observedAt: new Date("2026-10-20T10:00:00Z"),
    });
  });

  it("reads a camelCase position report with metadata coordinates and alternate field names", () => {
    const parsed = parseAisStreamMessage(
      Buffer.from(
        msg({
          metadata: {
            mmsi: "366123456",
            shipName: "  ",
            latitude: "10.5",
            longitude: "-20",
            TimeUtc: 1_760_000_000_000,
          },
          message: {
            positionReport: {
              SOG: 3,
              COG: null,
              speedOverGround: 9,
              courseOverGround: 45,
              trueHeading: "x",
              navigationStatus: " ",
            },
          },
        })
      )
    );
    expect(parsed).toEqual({
      kind: "position",
      mmsi: "366123456",
      vesselName: null,
      latitude: 10.5,
      longitude: -20,
      speedKnots: 3,
      course: 45,
      heading: null,
      navigationStatus: null,
      observedAt: new Date(1_760_000_000_000),
    });
    const lowercase = parseAisStreamMessage(
      msg({
        metadata: { mmsi: "366123456", timestamp: "bad" },
        message: { positionReport: { latitude: 1, longitude: 2, speedOverGround: "" } },
      })
    );
    expect(lowercase).toMatchObject({ latitude: 1, longitude: 2, speedKnots: null, course: null });
    expect((lowercase as { observedAt: Date }).observedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(
      parseAisStreamMessage(
        msg({ MetaData: { MMSI: 366123456, Latitude: 5, Longitude: 6, time_utc: {} }, Message: { PositionReport: {} } })
      )
    ).toMatchObject({ latitude: 5, longitude: 6 });
  });

  it("rejects missing or out-of-range coordinates", () => {
    const at = (Latitude: unknown, Longitude: unknown) =>
      parseAisStreamMessage(
        msg({ MetaData: { MMSI: 366123456 }, Message: { PositionReport: { Latitude, Longitude } } })
      );
    expect(at(null, 10)).toBeNull();
    expect(at(10, "  ")).toBeNull();
    expect(at(-90.1, 0)).toBeNull();
    expect(at(90.1, 0)).toBeNull();
    expect(at(0, -180.1)).toBeNull();
    expect(at(0, 180.1)).toBeNull();
    expect(at(-90, 180)).toMatchObject({ latitude: -90, longitude: 180 });
    expect(at(90, -180)).toMatchObject({ latitude: 90, longitude: -180 });
  });

  it("reads static ship data with IMO, destination and ETA", () => {
    expect(
      parseAisStreamMessage(
        msg({
          MetaData: { MMSI: 366123456, ShipName: "META NAME", time_utc: "2026-10-20T10:00:00Z" },
          Message: {
            ShipStaticData: {
              ImoNumber: 9811000.7,
              Name: " MSC ANNA ",
              Destination: " DURBAN ",
              Eta: "2026-11-02T06:00:00Z",
            },
          },
        })
      )
    ).toEqual({
      kind: "static",
      mmsi: "366123456",
      vesselName: "MSC ANNA",
      imo: "9811000",
      destination: "DURBAN",
      eta: new Date("2026-11-02T06:00:00Z"),
      observedAt: new Date("2026-10-20T10:00:00Z"),
    });
    const camel = parseAisStreamMessage(
      msg({
        MetaData: { MMSI: 366123456, ShipName: "META NAME" },
        message: { shipStaticData: { IMO: "0", name: "", destination: null, ETA: 1_770_000_000_000 } },
      })
    );
    expect(camel).toMatchObject({
      vesselName: "META NAME",
      imo: null,
      destination: null,
      eta: new Date(1_770_000_000_000),
    });
    const lower = parseAisStreamMessage(
      msg({ MetaData: { MMSI: 366123456 }, Message: { ShipStaticData: { imo: -3, eta: "soon" } } })
    );
    expect(lower).toMatchObject({ vesselName: null, imo: null, eta: null });
    const objectEta = parseAisStreamMessage(
      msg({ MetaData: { MMSI: 366123456 }, Message: { ShipStaticData: { Eta: { Month: 11 } } } })
    );
    expect(objectEta).toMatchObject({ imo: null, eta: null });
  });
});
