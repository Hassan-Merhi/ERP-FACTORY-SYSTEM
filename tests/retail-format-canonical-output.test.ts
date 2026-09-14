import fs from "node:fs";
import path from "node:path";
import * as prettier from "prettier";
import { expect, it } from "vitest";

it("captures the canonical Prettier output for RetailInventory", async () => {
  const filePath = path.join(process.cwd(), "client/src/pages/retail/RetailInventory.tsx");
  const source = fs.readFileSync(filePath, "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".prettierrc"), "utf8"));
  const formatted = await prettier.format(source, { ...config, filepath: filePath });

  console.log(`RETAIL_FORMATTED_BASE64=${Buffer.from(formatted, "utf8").toString("base64")}`);
  expect(source).toBe(formatted);
});
