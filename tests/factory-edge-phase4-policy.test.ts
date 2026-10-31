import { describe, expect, it } from "vitest";
import {
  edgeBlocksWrite,
  readFactoryEdgeConfiguration,
  shouldStartEdgeBackgroundJobs,
} from "../server/edge/edgeRuntimePolicy.mjs";

describe("Phase 4 safe writer handoff", () => {
  it("keeps the existing cloud default", () => {
    const config = readFactoryEdgeConfiguration({});
    expect(config.writeMode).toBe("cloud");
    expect(edgeBlocksWrite(config, "POST", "/api/vouchers/with-entries")).toBe(false);
  });
  it("refuses a fenced mode without confirmation", () => {
    expect(() => readFactoryEdgeConfiguration({ FACTORY_CLOUD_WRITE_MODE: "fenced" })).toThrow(
      "CLOUD_FENCE_NOT_ACKNOWLEDGED"
    );
  });
  it("does not run background jobs in configured read-only cloud mode", () => {
    const config = readFactoryEdgeConfiguration({
      FACTORY_CLOUD_WRITE_MODE: "fenced",
      FACTORY_CLOUD_FENCE_ACK: "CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF",
    });
    expect(edgeBlocksWrite(config, "POST", "/api/vouchers/with-entries")).toBe(true);
    expect(shouldStartEdgeBackgroundJobs(config)).toBe(false);
  });
});
