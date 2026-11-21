import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import * as prettier from "prettier";
/** Temporary validation helper: only for reporting canonical formatting of PR files. */
describe("FX correction Prettier output diagnostic", () => {
  it("emits normalized source for review, then this diagnostic will be removed", async () => {
    const paths = ["client/src/pages/daybook/FxRevaluationCorrectionDialog.tsx","client/src/i18n/sharedUiPhase3Translations.part7.ts","server/routes/monetaryFxRoutes.ts","server/middleware/unifiedAccountingRolloutBoundary.ts","server/services/accounting/fxRevaluationCorrection.ts","server/services/accounting/fxCorrectionAmountOverrides.ts","tests/fx-revaluation-correction.test.ts","tests/fx-usd-amount-overrides.test.ts","tests/fx-correction-rollout-access.test.ts"];
    for (const path of paths) {
      const input = await fs.readFile(path, "utf8");
      const config = (await prettier.resolveConfig(path)) ?? {};
      const output = await prettier.format(input, { ...config, filepath: path });
      console.log("FXFORMAT|" + path + "|" + Buffer.from(output, "utf8").toString("base64") + "|END");
    }
    expect(paths.length).toBe(9);
  });
});
