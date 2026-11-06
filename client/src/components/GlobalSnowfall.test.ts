import { describe, expect, it } from "vitest";
import { snowfallParticleCount } from "./GlobalSnowfall";

describe("global Christmas snowfall density", () => {
  it("keeps mobile workloads deliberately small", () => {
    expect(snowfallParticleCount(375, 812)).toBeGreaterThanOrEqual(12);
    expect(snowfallParticleCount(375, 812)).toBeLessThanOrEqual(24);
    expect(snowfallParticleCount(500, 1400)).toBeLessThanOrEqual(24);
  });

  it("uses a bounded desktop density", () => {
    expect(snowfallParticleCount(1440, 900)).toBeGreaterThan(24);
    expect(snowfallParticleCount(3840, 2160)).toBe(64);
  });

  it("never requests an unbounded number of particles", () => {
    expect(snowfallParticleCount(1, 1)).toBe(12);
    expect(snowfallParticleCount(640, 1)).toBe(24);
  });
});
