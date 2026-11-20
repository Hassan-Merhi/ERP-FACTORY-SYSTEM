/**
 * TEMPORARY CI formatting diagnostic. Removed as soon as the two Phase 3
 * source files match Prettier. Contains only public repository source text.
 */
import { describe, it } from "vitest";
import { readFile } from "node:fs/promises";
import * as prettier from "prettier";

describe("Phase 3 temporary Prettier diagnostic", () => {
  it("prints the exact expected formatting as base64 for correction", async () => {
    for (const path of [
      "server/services/accounting/manualFxCorrectionPreflight.ts",
      "tests/zambia-fx-phase3.database.test.ts",
    ]) {
      const source = await readFile(path, "utf8");
      const config = await prettier.resolveConfig(path);
      const formatted = await prettier.format(source, { ...config, filepath: path });
      console.log("PHASE3_PRETTIER_BEGIN " + path);
      console.log(Buffer.from(formatted).toString("base64"));
      console.log("PHASE3_PRETTIER_END " + path);
    }
  });
});
