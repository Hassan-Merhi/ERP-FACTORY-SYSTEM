import { describe, expect, it } from "vitest";
import { parsePublishedTrainingManifest, TRAINING_MANIFEST_KEY } from "../shared/trainingMediaManifest";

const sha = "7f3e07f2cbfc67e31df7eb08b195c8164f2c1f46";
const entry = {
  videoKey: "training/videos/factory-overview/" + sha + ".mp4",
  captionsKey: "training/videos/factory-overview/" + sha + ".vtt",
  screenshotKey: "training/videos/factory-overview/" + sha + ".png",
  guideSteps: ["Open the overview."],
  sourceSha: sha,
  publishedAt: "2026-11-06T02:30:00.000Z",
  publishedBy: "nightly-audit",
  durationSeconds: 1192,
};

describe("published training manifest", () => {
  it("accepts a well-formed nightly manifest", () => {
    const parsed = parsePublishedTrainingManifest({ "factory-overview": entry });
    expect(parsed["factory-overview"].videoKey).toBe(entry.videoKey);
    expect(parsed["factory-overview"].guideSteps).toEqual(["Open the overview."]);
    expect(TRAINING_MANIFEST_KEY).toBe("training/manifest/current.json");
  });
  it("rejects keys outside the immutable media namespace or belonging to another topic", () => {
    expect(() =>
      parsePublishedTrainingManifest({ "factory-overview": { ...entry, videoKey: "training/manifest/current.json" } })
    ).toThrow();
    expect(() =>
      parsePublishedTrainingManifest({
        "factory-overview": { ...entry, videoKey: "training/videos/erp-pos/" + sha + ".mp4" },
      })
    ).toThrow();
    expect(() =>
      parsePublishedTrainingManifest({
        "factory-overview": { ...entry, captionsKey: "training/videos/factory-overview/" + sha + ".mp4" },
      })
    ).toThrow();
    expect(() => parsePublishedTrainingManifest({ "../x": entry })).toThrow();
    expect(() => parsePublishedTrainingManifest([entry])).toThrow();
  });
  it("rejects malformed metadata instead of partially trusting it", () => {
    expect(() => parsePublishedTrainingManifest({ "factory-overview": { ...entry, sourceSha: "main" } })).toThrow();
    expect(() =>
      parsePublishedTrainingManifest({ "factory-overview": { ...entry, guideSteps: ["", "ok"] } })
    ).toThrow();
    expect(() => parsePublishedTrainingManifest({ "factory-overview": { ...entry, durationSeconds: -1 } })).toThrow();
  });
});
