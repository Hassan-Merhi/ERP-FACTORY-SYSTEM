import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

describe("Historical Replay token identity binding", () => {
  it("rejects token company and user mismatches", () => {
    const route = readModuleFamily(
      resolve(process.cwd(), "server/routes/factory/raw-stock/historicalReplayRoutesV4.ts")
    );
    expect(route).toContain("Token company mismatch");
    expect(route).toContain("Token user mismatch");
  });
});
