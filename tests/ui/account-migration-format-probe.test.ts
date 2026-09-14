import { readFileSync } from "fs";
import { describe, it } from "vitest";
import { format } from "prettier";

const files = [
  "server/routes/admin/accountMigrationSafeRoutes.ts",
  "tests/account-migration-control-reference-safety.test.ts",
];

describe("account migration frontend format probe", () => {
  it("prints Prettier output for changed files", async () => {
    for (const path of files) {
      const formatted = await format(readFileSync(path, "utf8"), { filepath: path });
      console.log(`FORMAT_PROBE_START:${path}\n${formatted}FORMAT_PROBE_END:${path}`);
    }
  });
});
