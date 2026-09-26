import { readFileSync } from "node:fs";

import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

const TARGETS = [
  "server/routes/stats/statsNetProfitRoutes.ts",
  "tests/employee-net-position-helper.test.ts",
];

// Diagnostic-only: removed before final PR.
describe("temporary prettier diagnostic", () => {
  it("prints exact formatted target files", async () => {
    for (const path of TARGETS) {
      const source = readFileSync(path, "utf8");
      const config = (await prettier.resolveConfig(path)) || {};
      const formatted = await prettier.format(source, { ...config, filepath: path });
      console.log(`__PRETTIER_START__${path}\n${formatted}__PRETTIER_END__${path}`);
      expect(formatted.length).toBeGreaterThan(0);
    }
  });
});
