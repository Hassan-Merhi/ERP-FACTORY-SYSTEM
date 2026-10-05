/**
 * The enforced Content-Security-Policy has no 'unsafe-eval', so the
 * spreadsheet editor's row insertion only works because the build rewrites
 * fortune-sheet's `new Function` calls (build/viteFortuneSheetNoEvalPlugin.ts).
 * Run the rewrite against the installed library so an upgrade that changes
 * that code fails here, and check the rewritten calls behave like the
 * originals.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteFortuneSheetEval } from "../build/viteFortuneSheetNoEvalPlugin";

const CORE = path.join(process.cwd(), "node_modules/@fortune-sheet/core/dist/index.esm.js");

function insertRows(code: string, d: unknown[], arr: string[], index: number, lefttop: boolean) {
  const body = lefttop
    ? `if (index === 0) { ${code.split("\n")[0]} } else { ${code.split("\n")[1]} }`
    : code.split("\n")[2];
  new Function("d", "arr", "index", body)(d, arr, index);
  return d;
}

describe("fortune-sheet no-eval rewrite", () => {
  it("removes every new Function call from the installed library", () => {
    const original = fs.readFileSync(CORE, "utf8");
    expect(original).toContain("new Function(");
    const rewritten = rewriteFortuneSheetEval(original);
    expect(rewritten).not.toMatch(/new Function\(/);
    expect(rewritten).toContain("d.unshift.apply(d, arr.map(");
  });

  it("inserts the same rows as the eval-based original", () => {
    const original = [
      'new Function("d", "return d.unshift(".concat(arr.join(","), ")"))(d);',
      'new Function("d", "return d.splice(".concat(index, ", 0, ").concat(arr.join(","), ")"))(d);',
      'new Function("d", "return d.splice(".concat(index + 1, ", 0, ").concat(arr.join(","), ")"))(d);',
    ].join("\n");
    const rewritten = rewriteFortuneSheetEval(original);
    const rows = [
      [{ v: 1, m: 'a"b' }, null],
      [{ v: 2 }, { ct: { fa: "General" } }],
    ];
    const arr = rows.map((row) => JSON.stringify(row));

    for (const [index, lefttop] of [
      [0, true],
      [1, true],
      [1, false],
    ] as const) {
      const base = () => [["x"], ["y"], ["z"]] as unknown[];
      expect(insertRows(rewritten, base(), arr, index, lefttop)).toEqual(
        insertRows(original, base(), arr, index, lefttop)
      );
    }
  });

  it("fails the build when the expected code is missing", () => {
    expect(() => rewriteFortuneSheetEval("const x = 1;")).toThrow(/expected code not found/);
  });
});
