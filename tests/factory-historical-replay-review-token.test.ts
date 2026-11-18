import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("Historical Replay review token", () => {
  it("binds expiration and exact scope into the signed preparation", () => {
    const route = readModuleFamily(
      resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayRoutesV4.ts")
    );
    expect(route).toContain("expiresAt: Date.now() + REPAIR_TOKEN_TTL_MS");
    expect(route).toContain("scope: normalizedScope");
    expect(route).toContain("fingerprint");
  });
});
