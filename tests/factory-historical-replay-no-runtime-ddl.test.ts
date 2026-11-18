import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hasTable } from "./helpers/schemaManifest";

describe("Historical Replay schema ownership", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("registers the raw-stock recalculation routes without any schema statement", () => {
    for (const file of [
      "server/routes/factory/raw-stock/rawStockRecalcRoutes.ts",
      "server/routes/factory/raw-stock/registerRawStockRecalcRoutes.ts",
      "server/routes/factory/raw-stock/recalc/_helpers.ts",
      "server/routes/factory/raw-stock/recalc/preview.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX/i);
      expect(source, file).not.toContain("mutablePool.query");
      expect(source, file).not.toContain("ensureUndoLogTable");
    }
  });

  it("keeps consumed-token and undo tables in the schema migrations", () => {
    expect(hasTable("factory_replay_consumed_tokens")).toBe(true);
    expect(hasTable("factory_recalc_undo_log")).toBe(true);
  });
});
