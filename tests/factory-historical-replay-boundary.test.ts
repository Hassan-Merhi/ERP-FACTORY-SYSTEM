import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Historical Replay phase 6 boundary", () => {
  it("documents that static audit is not authorization to apply", () => {
    const audit = readFileSync(
      resolve(process.cwd(), "docs/archive/historical-replay-phase-6-static-audit.md"),
      "utf8"
    );
    expect(audit).toContain("This is a source-level audit only");
    expect(audit).toContain("not authorization to apply Historical Replay");
    expect(audit).toContain("DO NOT RUN OR APPLY HISTORICAL REPLAY");
  });
});
