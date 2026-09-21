import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { describe, it } from "vitest";

const targets = [
  "server/routes/factory/factoryBilingualSnapshotRoutes.ts",
  "tests/performance-wave4-database-hotspots.test.ts",
];

describe("Wave 4 Prettier probe", () => {
  it("prints canonical formatting for the two remaining files", async () => {
    for (const target of targets) {
      const source = readFileSync(resolve(process.cwd(), target), "utf8");
      const config = (await resolveConfig(target)) ?? {};
      const formatted = await format(source, { ...config, filepath: target });
      console.log(`WAVE4_FORMAT_START ${target}`);
      console.log(Buffer.from(formatted, "utf8").toString("base64"));
      console.log(`WAVE4_FORMAT_END ${target}`);
    }
    process.exit(13);
  });
});
