import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSeasonalCameraActive,
  pauseSeasonalEffectsForCamera,
  subscribeSeasonalCameraActivity,
} from "./seasonalCameraActivity";

const dataset: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of Object.keys(dataset)) delete dataset[key];
  vi.stubGlobal("document", { documentElement: { dataset } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("seasonal camera performance guard", () => {
  it("pauses effects until every camera has released its lease", () => {
    const releaseMobileCamera = pauseSeasonalEffectsForCamera();
    const releasePressingCamera = pauseSeasonalEffectsForCamera();
    try {
      expect(isSeasonalCameraActive()).toBe(true);
      expect(dataset.seasonalCameraActive).toBe("true");

      releaseMobileCamera();
      expect(isSeasonalCameraActive()).toBe(true);
      expect(dataset.seasonalCameraActive).toBe("true");

      releasePressingCamera();
      expect(isSeasonalCameraActive()).toBe(false);
      expect(dataset.seasonalCameraActive).toBeUndefined();
    } finally {
      releaseMobileCamera();
      releasePressingCamera();
    }
  });

  it("is idempotent on camera close, interruption and effect cleanup", () => {
    const release = pauseSeasonalEffectsForCamera();
    release();
    release();
    release();
    expect(isSeasonalCameraActive()).toBe(false);
    expect(dataset.seasonalCameraActive).toBeUndefined();
  });

  it("notifies subscribers only when the global active state changes", () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribeSeasonalCameraActivity(subscriber);
    try {
      const first = pauseSeasonalEffectsForCamera();
      const second = pauseSeasonalEffectsForCamera();
      expect(subscriber).toHaveBeenCalledTimes(1);
      first();
      expect(subscriber).toHaveBeenCalledTimes(1);
      second();
      expect(subscriber).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
    const later = pauseSeasonalEffectsForCamera();
    later();
    expect(subscriber).toHaveBeenCalledTimes(2);
  });
});
