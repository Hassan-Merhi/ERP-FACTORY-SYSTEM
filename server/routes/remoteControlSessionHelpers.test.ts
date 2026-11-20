import { describe, expect, it } from "vitest";
import { eventData } from "./remoteControlSessionHelpers";

describe("remote control event stream data", () => {
  it("escapes markup characters and parses back to the same value", () => {
    const payload = { sessionId: "s-1", tabId: "<script>alert(1)</script>&x", note: "a\nb" };
    const data = eventData(payload);
    expect(data).not.toMatch(/[<>&\n]/);
    expect(JSON.parse(data)).toEqual(payload);
  });
});
