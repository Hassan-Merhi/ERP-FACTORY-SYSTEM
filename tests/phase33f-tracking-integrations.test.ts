import { afterEach, describe, expect, it, vi } from "vitest";

import { isTrackTraceScraper, scrapeTrackTrace } from "../server/lib/trackTraceScraper";
import { isEnabled as isMaerskPublicEnabled, track as trackMaerskPublic } from "../server/lib/trackingProviders/maerskPublicProvider";
import { formatEtaDate, extractFromJson, isMaerskDirectScraperAvailable } from "../server/lib/maerskDirectScraper";

function prefetchResponse(cookie = "session=abc; Path=/") {
  return {
    body: { cancel: vi.fn(async () => undefined) },
    headers: { get: (name: string) => (name.toLowerCase() === "set-cookie" ? cookie : null) },
  } as any;
}

function apiResponse({
  status = 200,
  ok = status >= 200 && status < 300,
  contentType = "application/json",
  json,
  text = "",
}: {
  status?: number;
  ok?: boolean;
  contentType?: string;
  json?: unknown;
  text?: string;
}) {
  return {
    status,
    ok,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: vi.fn(async () => json),
    text: vi.fn(async () => text),
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Phase 33F tracking integrations", () => {
  it("keeps Track-Trace optional and returns a typed unavailable result when Chromium support is absent", async () => {
    const available = isTrackTraceScraper();
    expect(typeof available).toBe("boolean");

    if (!available) {
      await expect(scrapeTrackTrace("MSKU1234567")).resolves.toEqual({
        success: false,
        shipment: null,
        blocked: false,
        error: "Puppeteer not available",
      });
    }
  });

  it("keeps Maersk public tracking enabled without credentials and handles provider blocking", async () => {
    expect(isMaerskPublicEnabled()).toBe(true);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(prefetchResponse())
      .mockResolvedValueOnce(apiResponse({ status: 403, ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await trackMaerskPublic("PH33F-BLOCKED-001");
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toBe("blocked_http_403");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes bot challenges from ordinary non-JSON Maersk responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(prefetchResponse(""))
        .mockResolvedValueOnce(
          apiResponse({ contentType: "text/html", text: "<html>DataDome captcha challenge</html>" })
        )
    );

    const challenge = await trackMaerskPublic("PH33F-CHALLENGE-002");
    expect(challenge.success).toBe(false);
    expect(challenge.blocked).toBe(true);
    expect(challenge.error).toBe("captcha_challenge");
  });

  it("parses destination ETA and latest useful event from Maersk public JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(prefetchResponse())
        .mockResolvedValueOnce(
          apiResponse({
            json: {
              shipment: {
                status: "IN_TRANSIT",
                portCalls: [
                  { eta: "2026-09-20", isDestination: false },
                  { estimatedArrival: "2026-10-04T08:30:00+02:00", isDestination: true },
                ],
                events: [
                  {
                    eventDateTime: "2026-09-10T08:00:00Z",
                    transportEventTypeCode: "LOAD",
                    location: { portName: "Jebel Ali" },
                    description: "Loaded",
                  },
                  {
                    eventDateTime: "2026-09-14T08:00:00Z",
                    activityName: "Departed",
                    locationName: "Salalah",
                  },
                ],
              },
            },
          })
        )
    );

    const result = await trackMaerskPublic("PH33F-SUCCESS-003");
    expect(result.success).toBe(true);
    expect(result.eta).toBe("2026-10-04");
    expect(result.latestStatus).toBe("Departed");
    expect(result.latestLocation).toBe("Salalah");
    expect(result.events).toHaveLength(2);
  });

  it("reports transport timeouts without throwing", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(prefetchResponse()).mockRejectedValueOnce(timeout));

    const result = await trackMaerskPublic("PH33F-TIMEOUT-004");
    expect(result.success).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("locks direct Maersk parser behavior for date normalization and destination selection", () => {
    expect(typeof isMaerskDirectScraperAvailable()).toBe("boolean");
    expect(formatEtaDate("2026-09-17T23:30:00-05:00")).toBe("2026-09-17");

    const parsed = extractFromJson({
      events: [
        { eventDateTime: "2026-09-11T12:00:00Z", status: "SAILED", location: "Dubai" },
      ],
      portCalls: [
        { eta: "2026-09-25", isDestination: false },
        { eta: "2026-10-07", isDestination: true },
      ],
    });
    expect(parsed.latestStatus).toBe("SAILED");
    expect(parsed.eta).toBe("2026-10-07");
  });
});
