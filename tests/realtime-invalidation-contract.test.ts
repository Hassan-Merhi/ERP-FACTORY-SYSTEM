import {
  classifyRealtimeWrite,
  parseRealtimeInvalidationMessage,
} from "../shared/realtimeInvalidation";

describe("realtime invalidation contract", () => {
  it("parses targeted messages and removes invalid topic/location values", () => {
    expect(
      parseRealtimeInvalidationMessage({
        type: "invalidate",
        topics: ["inventory", "inventory", "not-a-topic"],
        locationIds: [4, "5", 0, -1, "bad", 4],
      })
    ).toEqual({
      type: "invalidate",
      topics: ["inventory"],
      locationIds: [4, 5],
    });
  });

  it("keeps legacy invalidate messages as the safe blanket form", () => {
    expect(parseRealtimeInvalidationMessage({ type: "invalidate" })).toEqual({ type: "invalidate" });
    expect(parseRealtimeInvalidationMessage({ type: "other" })).toBeNull();
    expect(parseRealtimeInvalidationMessage(null)).toBeNull();
  });

  it("classifies POS writes into POS, inventory and accounting", () => {
    expect(classifyRealtimeWrite("/api/pos/sales?station=3", { locationId: 9 })).toEqual({
      topics: ["pos", "inventory", "accounting"],
      locationIds: [9],
    });
  });

  it("classifies stock transfers and captures both locations", () => {
    expect(
      classifyRealtimeWrite("/api/stock-transfers", {
        fromLocationId: 2,
        toLocationId: "7",
      })
    ).toEqual({
      topics: ["inventory", "accounting"],
      locationIds: [2, 7],
    });
  });

  it("classifies location and inventory writes and extracts a location from the path", () => {
    expect(classifyRealtimeWrite("/api/locations/12/inventory/adjust", {})).toEqual({
      topics: ["inventory"],
      locationIds: [12],
    });
    expect(classifyRealtimeWrite("/api/inventory/quick-adjust", { location_id: 3 })).toEqual({
      topics: ["inventory"],
      locationIds: [3],
    });
  });

  it("classifies accounting write families", () => {
    expect(classifyRealtimeWrite("/api/vouchers/44", {})).toEqual({ topics: ["accounting"] });
    expect(classifyRealtimeWrite("/api/accounts/77", {})).toEqual({ topics: ["accounting"] });
  });

  it("classifies payroll before the broader factory family", () => {
    expect(classifyRealtimeWrite("/api/factory/payrolls/8", {})).toEqual({
      topics: ["factory", "payroll"],
    });
    expect(classifyRealtimeWrite("/api/factory/ground-scan", { locationId: 5 })).toEqual({
      topics: ["factory"],
      locationIds: [5],
    });
  });

  it("classifies container/import/SP writes as their cross-domain dependencies", () => {
    expect(classifyRealtimeWrite("/api/containers/123", {})).toEqual({
      topics: ["containers", "inventory", "accounting"],
    });
    expect(classifyRealtimeWrite("/api/sp/offload", {})).toEqual({
      topics: ["containers", "inventory", "accounting"],
    });
  });

  it("classifies reference and communication writes", () => {
    expect(classifyRealtimeWrite("/api/suppliers/3", {})).toEqual({ topics: ["reference"] });
    expect(classifyRealtimeWrite("/api/chat/messages", {})).toEqual({ topics: ["communications"] });
  });

  it("leaves unknown writes unclassified so clients use blanket fallback", () => {
    expect(classifyRealtimeWrite("/api/new-module/something", { destinationLocationId: 14 })).toEqual({
      locationIds: [14],
    });
  });

  it("ignores invalid bodies and invalid location identifiers", () => {
    expect(classifyRealtimeWrite("/api/inventory/quick-adjust", null)).toEqual({ topics: ["inventory"] });
    expect(
      classifyRealtimeWrite("/api/inventory/quick-adjust", {
        locationId: 0,
        sourceLocationId: "x",
        destinationLocationId: 2.5,
      })
    ).toEqual({ topics: ["inventory"] });
  });
});
