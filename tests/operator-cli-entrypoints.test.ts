import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("renamed offline operator entrypoints", () => {
  it.each(["server/edge/eventStreamOperatorApply.ts", "server/edge/stagedVoucherOperatorApply.ts"])(
    "executes %s and rejects missing arguments without applying data",
    (entrypoint) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, NODE_ENV: "test", ENABLE_SCHEDULERS: "false" },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(result.stderr).toContain(`Usage: node --import tsx ${entrypoint}`);
    }
  );
});
