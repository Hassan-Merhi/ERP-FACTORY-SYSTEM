import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Wave 3 API payload and bandwidth ratchet", () => {
  it("keeps compact contracts, lazy details, caching and continuous-list invariants intact", () => {
    const result = spawnSync(process.execPath, ["scripts/verify-wave3-api-payload-bandwidth.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
    expect(result.stdout).toContain("Wave 3 API payload and bandwidth verification passed.");
  });
});
