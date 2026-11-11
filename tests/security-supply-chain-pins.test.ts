import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

describe("immutable supply-chain pins for the factory edge and Pullfrog", () => {
  const dockerfile = file("deploy/lan/Dockerfile");
  const pullfrog = file(".github/workflows/pullfrog.yml");

  it("pins both Docker stages to one resolved, full-length Node 24.22.2 manifest digest", () => {
    const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
    expect(images).toHaveLength(2);
    expect(images[0]).toMatch(/^node:24\.22\.2-bookworm-slim@sha256:[a-f0-9]{64}$/);
    expect(images[1]).toBe(images[0]);
    expect(dockerfile).not.toContain("FROM node:24-bookworm-slim");
  });

  it("ships the hardened deepmerge override before container dependency installation", () => {
    const vendorCopy = dockerfile.indexOf("COPY vendor/secure-deepmerge/");
    const install = dockerfile.indexOf("RUN npm ci");
    expect(vendorCopy).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(vendorCopy);
    expect(dockerfile).toContain("RUN npm prune --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER node");
  });

  it("pins Pullfrog to the verified v0.1.123 release commit, never a mutable tag", () => {
    // 3c58d31 is what refs/tags/v0.1.123 resolves to in pullfrog/pullfrog (checked 2026-11-09).
    expect(pullfrog).toContain("uses: pullfrog/pullfrog@3c58d31073422cc1b9573f58b5dbadb7a4914715 # v0.1.123");
    expect(pullfrog).not.toMatch(/uses:\s*pullfrog\/pullfrog@v(?:\d|$)/m);
    expect(pullfrog).toContain("persist-credentials: false");
  });
});
