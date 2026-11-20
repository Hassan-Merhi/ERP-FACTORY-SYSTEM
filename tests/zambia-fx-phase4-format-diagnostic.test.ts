/**
 * Temporary Phase 4 CI formatting diagnostic. Remove after formatting repair.
 */
import { describe, it } from "vitest";
import { readFile } from "node:fs/promises";
import * as prettier from "prettier";

describe("Phase 4 temporary Prettier diagnostic", () => {
  it("emits exact formatted source for Phase 4 files", async () => {
    for (const path of [
      "server/services/accounting/manualFxCorrectionAudit.ts",
      "server/services/accounting/manualFxCorrectionVerification.ts",
      "tests/zambia-fx-phase4-audit.test.ts",
      "tests/zambia-fx-phase4.database.test.ts",
    ]) {
      const source = await readFile(path, "utf8");
      const config = await prettier.resolveConfig(path);
      const formatted = await prettier.format(source, { ...config, filepath: path });
      console.log("PHASE4_PRETTIER_BEGIN " + path);
      console.log(Buffer.from(formatted).toString("base64"));
      console.log("PHASE4_PRETTIER_END " + path);
    }
  });
});
