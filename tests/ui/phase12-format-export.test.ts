import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

// Temporary CI-only formatter export, removed before the release PR is merged.
describe("Phase 12 formatting repair", () => {
  it("prints exact Prettier-formatted source as numbered base64 chunks", async () => {
    const files = [
      "client/src/pages/factory/FactoryCustomers.tsx",
      "client/src/pages/vouchers/voucher-premium.css",
    ];
    for (const file of files) {
      const absolutePath = resolve(process.cwd(), file);
      const config = await prettier.resolveConfig(absolutePath);
      const original = readFileSync(absolutePath, "utf8");
      const formatted = await prettier.format(original, { ...config, filepath: absolutePath });
      const encoded = Buffer.from(formatted, "utf8").toString("base64");
      const chunkSize = 1600;
      const total = Math.ceil(encoded.length / chunkSize);
      for (let part = 0; part < total; part += 1) {
        const chunk = encoded.slice(part * chunkSize, (part + 1) * chunkSize);
        console.log(`PHASE12_FORMAT_CHUNK ${file} ${part + 1}/${total} ${chunk}`);
      }
      expect(formatted.length).toBeGreaterThan(0);
    }
  });
});
