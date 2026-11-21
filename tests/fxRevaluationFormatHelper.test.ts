import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import * as prettier from "prettier";

/** TEMPORARY: emit canonical Prettier output for the FX correction files in private CI logs. Delete after applying. */
describe("Temporary formatting helper for FX correction PR", () => {
  it("renders all changed FX TypeScript sources using repo formatting config", async () => {
    const files = [
      "client/src/pages/daybook/FxRevaluationCorrectionDialog.tsx",
      "client/src/pages/daybook/VoucherDetailsDialog.tsx",
      "client/src/i18n/sharedUiPhase3Translations.part7.ts",
      "server/routes/monetaryFxRoutes.ts",
      "server/services/accounting/fxRevaluationCorrection.ts",
      "server/services/accounting/monetaryFxValuationService.ts",
    ];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      const config = (await prettier.resolveConfig(file)) ?? {};
      const formatted = await prettier.format(source, { ...config, filepath: file });
      console.log("FXFMT_BEGIN:" + file + ":" + Buffer.from(formatted, "utf8").toString("base64") + ":FXFMT_END");
      console.log("FXFMT_LINES:" + file + ":" + formatted.split("\n").length);
    }
    expect(files).toHaveLength(6);
  });
});
