import { it } from "vitest";
import { readFileSync } from "node:fs";
import prettier from "prettier";

it("prints exact Prettier output for PR 2121 changed files", async () => {
  const paths = [
    "client/src/pages/ItemMarketAnalysis.tsx",
    "client/src/pages/itemMarketAnalysisExport.ts",
    "server/routes/stats/itemMarketAnalysisRoutes.ts",
    "server/services/reports/itemMarketBulkSalePrices.test.ts",
    "server/services/reports/itemMarketBulkSalePrices.ts",
  ];
  for (const path of paths) {
    const original = readFileSync(path, "utf8");
    const options = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(original, { ...options, filepath: path });
    console.log("MARKET_PRETTIER:" + path + ":" + Buffer.from(formatted).toString("base64") + ":END_MARKET_PRETTIER");
  }
});
