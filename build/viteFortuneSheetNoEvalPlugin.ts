import type { Plugin } from "vite";

/**
 * @fortune-sheet/core inserts rows by JSON-stringifying each new row and then
 * evaluating `d.unshift(<json>, ...)` / `d.splice(i, 0, <json>, ...)` through
 * `new Function`. The Content-Security-Policy forbids eval, so inserting rows
 * in the spreadsheet editor would throw. The strings are JSON.stringify
 * output, so JSON.parse yields the same values; this rewrites the three calls
 * to do exactly that. The build fails if the library code no longer matches,
 * so an upgrade cannot silently reintroduce eval.
 */
const FORTUNE_SHEET_CORE = /\/@fortune-sheet\/core\/dist\/index\.esm\.js$/;

const PARSED = "arr.map(function (json) { return JSON.parse(json); })";

export const FORTUNE_SHEET_EVAL_REWRITES: ReadonlyArray<readonly [string, string]> = [
  [
    'new Function("d", "return d.unshift(".concat(arr.join(","), ")"))(d);',
    `d.unshift.apply(d, ${PARSED});`,
  ],
  [
    'new Function("d", "return d.splice(".concat(index, ", 0, ").concat(arr.join(","), ")"))(d);',
    `d.splice.apply(d, [index, 0].concat(${PARSED}));`,
  ],
  [
    'new Function("d", "return d.splice(".concat(index + 1, ", 0, ").concat(arr.join(","), ")"))(d);',
    `d.splice.apply(d, [index + 1, 0].concat(${PARSED}));`,
  ],
];

export function rewriteFortuneSheetEval(code: string): string {
  let next = code;
  for (const [from, to] of FORTUNE_SHEET_EVAL_REWRITES) {
    if (!next.includes(from)) {
      throw new Error(`fortune-sheet no-eval rewrite: expected code not found: ${from}`);
    }
    next = next.split(from).join(to);
  }
  if (/new Function\(/.test(next)) {
    throw new Error("fortune-sheet no-eval rewrite: an unexpected new Function( call remains");
  }
  return next;
}

export function fortuneSheetNoEvalPlugin(): Plugin {
  return {
    name: "erp-fortune-sheet-no-eval",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, "/").split("?")[0];
      if (!FORTUNE_SHEET_CORE.test(normalizedId)) return null;
      return { code: rewriteFortuneSheetEval(code), map: null };
    },
  };
}
