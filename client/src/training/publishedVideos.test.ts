import { describe, expect, it } from "vitest";
import { buildPublishedTrainingMaps } from "./publishedVideos";

describe("published training media listing", () => {
  it("maps every published topic to its authenticated playback routes", () => {
    const maps = buildPublishedTrainingMaps({
      provider: "vercel",
      topics: {
        "factory-overview": {
          guideSteps: ["Open the overview.", "Check the company."],
          captions: true,
          screenshot: true,
          sourceSha: "7f3e07f2cbfc67e31df7eb08b195c8164f2c1f46",
          publishedAt: "2026-11-06T02:30:00.000Z",
          durationSeconds: 1192,
        },
        "erp-pos": {
          guideSteps: [],
          captions: false,
          screenshot: false,
          sourceSha: null,
          publishedAt: null,
          durationSeconds: 84,
        },
      },
    });
    expect(maps.videos).toEqual({
      "factory-overview": "/api/training/media/factory-overview",
      "erp-pos": "/api/training/media/erp-pos",
    });
    expect(maps.captions).toEqual({ "factory-overview": "/api/training/media/factory-overview/captions" });
    expect(maps.screenshots).toEqual({ "factory-overview": "/api/training/media/factory-overview/screenshot" });
    expect(maps.guides).toEqual({ "factory-overview": ["Open the overview.", "Check the company."] });
  });
  it("renders an empty library while nothing is published or the listing has not loaded", () => {
    expect(buildPublishedTrainingMaps(undefined).videos).toEqual({});
    expect(buildPublishedTrainingMaps({ provider: "static", topics: {} }).videos).toEqual({});
    expect(
      buildPublishedTrainingMaps({
        provider: "static",
        topics: {
          "../x": {
            guideSteps: [],
            captions: false,
            screenshot: false,
            sourceSha: null,
            publishedAt: null,
            durationSeconds: null,
          },
        },
      }).videos
    ).toEqual({});
  });
});
