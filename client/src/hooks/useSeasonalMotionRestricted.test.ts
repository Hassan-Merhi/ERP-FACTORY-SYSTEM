import { afterEach, describe, expect, it, vi } from "vitest";
import { seasonalMotionRestricted } from "./useSeasonalMotionRestricted";

afterEach(() => vi.unstubAllGlobals());

describe("seasonal animation accessibility and data saver policy", () => {
  it("permits animation when reduced motion and data saver are both off", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    expect(seasonalMotionRestricted()).toBe(false);
  });

  it("disables animation when the user enables reduced motion", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query.includes("prefers-reduced-motion") }),
    });
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    expect(seasonalMotionRestricted()).toBe(true);
  });

  it("disables animation when the browser requests reduced data", () => {
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: query.includes("prefers-reduced-data") }),
    });
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    expect(seasonalMotionRestricted()).toBe(true);
  });

  it("honors network saveData even when media queries report false", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    expect(seasonalMotionRestricted()).toBe(true);
  });

  it("fails safely when media query support is unavailable", () => {
    vi.stubGlobal("window", {
      matchMedia: () => {
        throw new Error("unavailable");
      },
    });
    vi.stubGlobal("navigator", { connection: undefined });
    expect(seasonalMotionRestricted()).toBe(false);
  });
});
