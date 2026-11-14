import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySourceFile, countPhysicalLines, evaluateApplicationFile } from "../scripts/audit-file-lines.mjs";

const policy = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".css", ".scss"],
  applicationRoots: ["client/src/", "server/", "shared/", "desktop/", "build/"]
};

describe("physical file line counts", () => {
  it("matches splitlines for empty, trailing LF, CRLF and no trailing newline", () => {
    assert.equal(countPhysicalLines(""), 0);
    assert.equal(countPhysicalLines("one"), 1);
    assert.equal(countPhysicalLines("one\n"), 1);
    assert.equal(countPhysicalLines("one\n\n"), 2);
    assert.equal(countPhysicalLines("a\r\nb\r\n"), 2);
    assert.equal(countPhysicalLines("a\rb"), 2);
  });
});

describe("classification and narrow exemptions", () => {
  it("tracks ERP, Factory, shared, desktop and build sources, including CSS", () => {
    for (const file of ["client/src/pages/factory/Loading.tsx", "server/routes/pos.ts", "shared/schema/core.ts", "desktop/main.mjs", "build/plugin.ts", "client/src/index.css"]) {
      assert.equal(classifySourceFile(file, policy), "application");
    }
  });
  it("keeps tests, translations and migrations out of hard-cap enforcement", () => {
    assert.equal(classifySourceFile("tests/stock.test.ts", policy), "test");
    assert.equal(classifySourceFile("client/src/pages/stock.test.tsx", policy), "test");
    assert.equal(classifySourceFile("client/src/i18n/translations.ts", policy), "translation");
    assert.equal(classifySourceFile("server/startup-schema/007.ts", policy), "schema_migration");
    assert.equal(classifySourceFile("scripts/check.mjs", policy), "tooling");
  });
  it("exempts only explicitly generated paths, not the rest of a large feature", () => {
    assert.equal(classifySourceFile("client/src/__generated__/types.ts", policy), "generated");
    assert.equal(classifySourceFile("client/src/pages/stock.generated.tsx", policy), "generated");
    assert.equal(classifySourceFile("client/src/pages/stock.tsx", policy), "application");
  });
  it("does not count docs, binary images or JSON as source", () => {
    assert.equal(classifySourceFile("docs/plan.md", policy), null);
    assert.equal(classifySourceFile("client/src/logo.png", policy), null);
    assert.equal(classifySourceFile("package-lock.json", policy), null);
  });
});

describe("300 warning / 500 hard cap", () => {
  it("accepts exactly 300 and warns at 301", () => {
    assert.equal(evaluateApplicationFile({ lines: 300 }).status, "ok");
    assert.equal(evaluateApplicationFile({ lines: 301 }).status, "warning");
  });
  it("allows exactly 500 and blocks 501 in new files", () => {
    assert.equal(evaluateApplicationFile({ lines: 500 }).status, "warning");
    assert.equal(evaluateApplicationFile({ lines: 501, legacyLines: null }).status, "failure");
  });
  it("blocks a preexisting compliant file that becomes over 500", () => {
    assert.equal(evaluateApplicationFile({ lines: 501, legacyLines: 499 }).status, "failure");
  });
  it("grandfathers a legacy oversized file unchanged", () => {
    assert.equal(evaluateApplicationFile({ lines: 800, legacyLines: 800 }).status, "grandfathered");
  });
  it("allows a legacy oversized file to shrink", () => {
    assert.equal(evaluateApplicationFile({ lines: 701, legacyLines: 800, comparedLines: 800 }).status, "grandfathered");
  });
  it("blocks legacy growth past the frozen reference size", () => {
    assert.equal(evaluateApplicationFile({ lines: 801, legacyLines: 800 }).status, "failure");
  });
  it("blocks re-growth after a partial reduction by comparing the merge-base", () => {
    const result = evaluateApplicationFile({ lines: 760, legacyLines: 800, comparedLines: 740 });
    assert.equal(result.status, "failure");
    assert.match(result.reason, /grew from 740 to 760/);
  });
  it("blocks re-adding or renaming a large legacy path on a PR", () => {
    assert.equal(evaluateApplicationFile({ lines: 800, legacyLines: 800, comparedLines: null }).status, "failure");
  });
  it("accepts an unchanged large legacy file relative to merge-base", () => {
    assert.equal(evaluateApplicationFile({ lines: 800, legacyLines: 800, comparedLines: 800 }).status, "grandfathered");
  });
});
