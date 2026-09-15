import { describe, expect, it } from "vitest";

import {
  deepScanForEta,
  extractFromJson,
  formatEtaDate,
  isMaerskDirectScraperAvailable,
} from "../server/lib/maerskDirectScraper";

describe("Maersk parser branch coverage", () => {
  it("covers ETA deep-scan guards, arrays and nested objects", () => {
    expect(deepScanForEta(null)).toBeNull();
    expect(deepScanForEta("2026-01-01")).toBeNull();
    expect(deepScanForEta({}, 13)).toBeNull();
    expect(deepScanForEta([{ foo: 1 }, { nested: { eta: "2026-10-03T23:00:00-04:00" } }])).toEqual({
      path: "eta",
      value: "2026-10-03",
    });
    expect(deepScanForEta({ estimatedArrival: "not-a-date", child: { plannedArrival: "2027-02-04" } })).toEqual({
      path: "plannedArrival",
      value: "2027-02-04",
    });
    expect(deepScanForEta({ eventDate: "2027-02-04", child: { value: "no eta here" } })).toBeNull();
  });

  it("covers date input coercion and invalid calendar values", () => {
    expect(formatEtaDate(undefined)).toBeNull();
    expect(formatEtaDate("   ")).toBeNull();
    expect(formatEtaDate("2030-01-02T23:59:00+11:00")).toBe("2030-01-02");
    expect(formatEtaDate("January 3, 2030")).toMatch(/^2030-01-03$/);
    expect(formatEtaDate({ bad: true })).toBeNull();
    expect(typeof isMaerskDirectScraperAvailable()).toBe("boolean");
  });

  it("covers synergy event ordering, vessel descriptions and status precedence", () => {
    const result = extractFromJson(
      {
        containers: [
          {
            container_num: "MSKU1111111",
            status: "IN_TRANSIT",
            locations: [
              {
                terminal: "Terminal A",
                city: "Shanghai",
                country: "CN",
                events: [
                  {
                    event_time: "2026-08-01T08:00:00+08:00",
                    event_time_type: "ACTUAL",
                    activity: "Loaded",
                    vessel_name: "Vessel One",
                    voyage_num: "V100",
                  },
                  { event_time: null, event_time_type: "EXPECTED", activity: "Departure" },
                ],
              },
              {
                city: "Durban",
                country: "ZA",
                events: [
                  {
                    event_time: "2099-10-20T08:00:00+02:00",
                    event_time_type: "EXPECTED",
                    activity: "Berthing",
                  },
                  {
                    event_time: "2099-10-18T08:00:00+02:00",
                    event_time_type: "EXPECTED",
                    activity: "Customs estimate",
                  },
                  {
                    event_time: "2026-09-01T08:00:00+02:00",
                    event_time_type: "ACTUAL",
                    activity: "Transshipment",
                  },
                ],
              },
            ],
          },
        ],
      },
      "MSKU1111111"
    );

    expect(result.synergy).toBe(true);
    expect(result.events).toHaveLength(5);
    expect(result.events[0].status).toBe("Berthing");
    expect(result.events.find((event) => event.status === "Loaded")?.description).toContain("Vessel One V100");
    expect(result.latestStatus).toBe("Transshipment");
    expect(result.eta).toBe("2099-10-18");
  });

  it("uses a synergy status field when there is no actual event", () => {
    const result = extractFromJson({
      containers: [
        {
          number: "MRKU2222222",
          status: "AT_DESTINATION",
          eta: "2026-11-06",
          locations: [
            { city: "Beira", events: [{ event_time: null, event_time_type: "EXPECTED", activity: "Arrival" }] },
          ],
        },
      ],
    });
    expect(result.synergy).toBe(true);
    expect(result.latestStatus).toBe("AT_DESTINATION");
    expect(result.eta).toBe("2026-11-06");
  });

  it("covers generic container events, destination port calls and field fallbacks", () => {
    const result = extractFromJson(
      {
        shipment: {
          containers: [
            {
              containerNumber: "MRSU3333333",
              containerEvents: [
                {
                  eventDateTime: "2026-07-02T12:00:00Z",
                  transportEventTypeCode: "LOAD",
                  location: { portName: "Jebel Ali" },
                  description: "Loaded on vessel",
                },
                {
                  eventDate: "bad-date",
                  activityName: "Unknown date event",
                  location: { city: "Dubai" },
                  eventDescription: "Waiting",
                },
              ],
              portCalls: [
                { eta: "2026-07-03", isDestination: false },
                { estimatedArrival: "2026-08-09T02:00:00+02:00", isDestination: "true" },
              ],
            },
          ],
        },
      },
      "mrsu 3333333"
    );

    expect(result.synergy).toBe(false);
    expect(result.eta).toBe("2026-08-09");
    expect(result.events).toHaveLength(2);
    expect(result.events[0].status).toBe("LOAD");
    expect(result.events[0].location).toBe("Jebel Ali");
    expect(result.events[1].date).toBeNull();
  });

  it("covers generic top-level event and ETA fallbacks", () => {
    const result = extractFromJson({
      events: [
        {
          timestamp: "2026-05-10T10:00:00Z",
          eventCode: "GATE_IN",
          locationName: "Tema",
          eventDescription: "Gate in",
        },
        {
          date: "2026-05-11T10:00:00Z",
          status: "SAILED",
          location: "Tema",
        },
      ],
      portCalls: [
        { eta: "2026-05-20", isDestination: false },
        { eta: "2026-06-01", isDestination: true },
      ],
    });
    expect(result.eta).toBe("2026-06-01");
    expect(result.events.map((event) => event.status)).toEqual(["SAILED", "GATE_IN"]);
  });

  it("covers empty, malformed and alternate generic shapes", () => {
    expect(extractFromJson(null)).toEqual({ events: [], eta: null, latestStatus: null, synergy: false });
    expect(extractFromJson("bad")).toEqual({ events: [], eta: null, latestStatus: null, synergy: false });

    const result = extractFromJson({
      data: {
        containers: [
          {
            containerNo: "HASU4444444",
            milestones: [
              {
                date: "2026-12-01",
                status: "ARRIVED",
                location: { locationName: "Lobito" },
                activityName: "Arrival",
              },
            ],
            plannedArrivalDate: "2026-12-01",
            portCalls: [],
          },
        ],
      },
    });
    expect(result.eta).toBe("2026-12-01");
    expect(result.events[0].status).toBe("Arrival");
  });
});
