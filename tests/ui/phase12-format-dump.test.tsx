import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { format, resolveConfig } from "prettier";
import { expect, it } from "vitest";

// Ephemeral formatter output for two legacy source files; remove this test before merging.
it("emits the exact repository Prettier result for Phase 12 repair", async () => {
  const paths = [
    "server/routes/vouchers/sales-update/optional.ts",
    "tests/factory-net-position-historical.database.test.ts",
  ];

  for (const path of paths) {
    const absolute = resolve(process.cwd(), path);
    const original = readFileSync(absolute, "utf8");
    const options = (await resolveConfig(absolute)) ?? {};
    const formatted = await format(original, { ...options, filepath: absolute });
    const chunkSize = 1000;
    const total = Math.ceil(formatted.length / chunkSize);
    for (let index = 0; index < total; index += 1) {
      console.log(
        "PHASE12_PRETTIER_RESULT:" +
          JSON.stringify({ path, index, total, chunk: formatted.slice(index * chunkSize, (index + 1) * chunkSize) })
      );
    }
    expect(formatted.length).toBeGreaterThan(0);
  }
});
