#!/usr/bin/env node
/**
 * audit-ui-unification-ratchet.mjs
 *
 * Guard rails for the UI unification program (docs/ui-unification/plan.md,
 * phase 10). Phases 1–9 moved the client onto shared pieces; this ratchet keeps
 * new code from reintroducing the patterns they replaced. It scans client/src
 * (tests excluded) and counts, per file, five patterns:
 *
 *   native-confirm         window.confirm( / bare confirm( calls.
 *                          Fix: `await confirmAction(...)` from @/lib/confirmAction.
 *   raw-export             Runtime imports of xlsx / xlsx-js-style / exceljs /
 *                          file-saver / jspdf, and `URL.createObjectURL(` followed
 *                          within a few lines by an anchor `download`, outside the
 *                          shared export helpers listed in exportHelperAllowlist.
 *                          `import type` and `typeof import(...)` are types only and
 *                          are not counted. Fix: excelHelper / universalExcelExport /
 *                          downloadBlob / exportFile (downloadFromUrl) / ReportExportMenu.
 *   bare-page-title        `<h1` under client/src/pages (JSX or HTML strings).
 *                          Fix: render the title through components/PageHeader.
 *   component-state-tabs   Under client/src/pages: a `<Tabs` whose `value={x}` comes
 *                          from `const [x, setX] = useState(...)` and whose
 *                          `onValueChange` calls setX, in a file that uses none of
 *                          useHubQueryState / useDaybookTab / useSearch. Fix: keep the
 *                          tab in the URL with useHubQueryState. A deliberately local
 *                          tab list (a dialog, a card) may carry the comment
 *                          `ui-unification-local-tabs: <reason>` within the three
 *                          lines above the `<Tabs`; such tab lists are not counted.
 *   hand-built-usd         A "$" literal joined to a .toFixed( / .toLocaleString( call:
 *                          `$${n.toFixed(2)}`, "$" + n.toFixed(2), or JSX text `$`
 *                          followed by {n.toFixed(2)}. Found through the TypeScript AST.
 *                          Fix: formatUsd / formatMoneyDisplay from @/lib/moneyDisplay.
 *
 * config/ui-unification-ratchet.json holds the exact per-file count of each
 * check. The gate fails when a file's count rises above its baseline or a file
 * that is not in the baseline gains a hit. When a count falls, it asks for the
 * baseline to be lowered (that is how the ratchet tightens) and still passes.
 *
 * Usage:
 *   npm run audit:ui-unification
 *   node scripts/audit-ui-unification-ratchet.mjs --json
 *   node scripts/audit-ui-unification-ratchet.mjs --root <dir> --config <file>   (fixtures)
 *   UPDATE_UI_UNIFICATION_BASELINE=1 node scripts/audit-ui-unification-ratchet.mjs
 *     rewrites the baseline from the current tree. Use it to record a drawdown,
 *     never to make a regression pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = "config/ui-unification-ratchet.json";

export const CHECKS = {
  "native-confirm": {
    title: "Native confirm() dialog",
    fix: "Replace it with `if (!(await confirmAction({ title, description }))) return;` from @/lib/confirmAction.",
  },
  "raw-export": {
    title: "Raw export library / blob download outside the shared export helpers",
    fix:
      "Build the file through @/lib/excelHelper or @/lib/universalExcelExport, download blobs with @/lib/downloadBlob, " +
      "URLs with downloadFromUrl (@/lib/exportFile), and put buttons in ReportExportMenu / ExportButton.",
  },
  "bare-page-title": {
    title: "Bare <h1> page title",
    fix: "Render the page title with <PageHeader title=... /> from @/components/PageHeader.",
  },
  "component-state-tabs": {
    title: "Page tab list held only in component state",
    fix:
      "Keep the open tab in the URL with useHubQueryState (@/hooks/useHubQueryState) so links, reloads and Back work. " +
      "If the tab list is deliberately local (inside a dialog or card), add `// ui-unification-local-tabs: <reason>` just above the <Tabs>.",
  },
  "hand-built-usd": {
    title: 'Hand-built "$" money string',
    fix: "Use formatUsd(amount, decimals) or formatMoneyDisplay(amount, { currency: \"USD\" }) from @/lib/moneyDisplay.",
  },
};

const CHECK_IDS = Object.keys(CHECKS);

// --------------------------------------------------------------------------
// File collection
// --------------------------------------------------------------------------

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isTestFile(relativePath) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath) ||
    /(^|\/)(__tests__|__mocks__)\//.test(relativePath) ||
    /(^|\/)(test-utils|testUtils)\.[jt]sx?$/.test(relativePath)
  );
}

function collectFiles(root, scan) {
  const out = [];
  const start = path.join(root, scan.root);
  if (!fs.existsSync(start)) return out;
  const walk = (absolute) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (scan.excludeDirectories.includes(entry.name)) continue;
        walk(path.join(absolute, entry.name));
        continue;
      }
      if (!scan.extensions.includes(path.extname(entry.name))) continue;
      const relative = toPosix(path.relative(root, path.join(absolute, entry.name)));
      if (isTestFile(relative)) continue;
      out.push(relative);
    }
  };
  walk(start);
  return out.sort();
}

// --------------------------------------------------------------------------
// Checks. Each returns the number of hits in one file.
// --------------------------------------------------------------------------

function stripLineComments(source) {
  // Good enough to skip commented-out code; strings containing "//" (URLs) keep
  // their tail because the pattern requires the "//" to start the trimmed line.
  return source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");
}

function countNativeConfirm(source) {
  const code = stripLineComments(source);
  const qualified = (code.match(/\b(?:window|globalThis|self)\.confirm\s*\(/g) ?? []).length;
  // A file that declares its own `confirm` (a hook result, a prop, a method)
  // calls that one; only the qualified global is native there.
  const declaresConfirm =
    /\b(?:const|let|var|function)\s+confirm\b|[{,]\s*confirm\s*[,}:=]|\bconfirm\s*\([^)]*\)\s*\{/.test(code);
  if (declaresConfirm) return qualified;
  return qualified + (code.match(/(?<![.\w$])confirm\s*\(/g) ?? []).length;
}

const EXPORT_LIBRARIES = "xlsx|xlsx-js-style|exceljs|file-saver|jspdf";
const STATIC_EXPORT_IMPORT = new RegExp(
  `^\\s*import\\s+(?!type\\b)[^;]*?from\\s+["'](?:${EXPORT_LIBRARIES})["']`,
  "gm"
);
const DYNAMIC_EXPORT_IMPORT = new RegExp(`(?<!typeof\\s)\\bimport\\(\\s*["'](?:${EXPORT_LIBRARIES})["']\\s*\\)`, "g");
const REQUIRE_EXPORT = new RegExp(`\\brequire\\(\\s*["'](?:${EXPORT_LIBRARIES})["']\\s*\\)`, "g");

function countRawExport(source) {
  const code = stripLineComments(source);
  let hits = 0;
  hits += (code.match(STATIC_EXPORT_IMPORT) ?? []).length;
  hits += (code.match(DYNAMIC_EXPORT_IMPORT) ?? []).length;
  hits += (code.match(REQUIRE_EXPORT) ?? []).length;
  const lines = code.split("\n");
  lines.forEach((line, index) => {
    if (!line.includes("URL.createObjectURL(")) return;
    const window = lines.slice(index, index + 8).join("\n");
    if (/\.download\s*=|setAttribute\(\s*["']download["']/.test(window)) hits += 1;
  });
  return hits;
}

function countBarePageTitles(source) {
  const code = stripLineComments(source);
  return (code.match(/<h1(?=[\s>/])/g) ?? []).length;
}

/** Returns the text of the `<Tabs ...>` opening tag starting at `start`. */
function openingTag(source, start) {
  let depth = 0;
  for (let index = start; index < source.length && index < start + 2000; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start, start + 2000);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countComponentStateTabs(source, relativePath, scan) {
  if (!relativePath.startsWith(scan.pagesRoot)) return 0;
  if (!/<Tabs\b/.test(source)) return 0;
  if (/\buse(?:HubQueryState|DaybookTab|Search)\b/.test(source)) return 0;

  const stateSetters = new Map();
  for (const match of source.matchAll(/const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*(?:React\.)?useState\b/g)) {
    stateSetters.set(match[1], match[2]);
  }
  if (stateSetters.size === 0) return 0;

  let hits = 0;
  for (const match of source.matchAll(/<Tabs(?=[\s>])/g)) {
    const before = source.slice(0, match.index).split("\n").slice(-4).join("\n");
    if (/ui-unification-local-tabs:/.test(before)) continue;
    const tag = openingTag(source, match.index);
    const value = tag.match(/\bvalue=\{\s*(\w+)\s*\}/);
    if (!value) continue;
    const setter = stateSetters.get(value[1]);
    if (!setter) continue;
    const onChange = tag.match(/\bonValueChange=\{([\s\S]*?)\}\s*(?:\w+=|\/?>)/);
    if (onChange && new RegExp(`\\b${escapeRegExp(setter)}\\b`).test(onChange[1])) hits += 1;
  }
  return hits;
}

const DOLLAR_AT_END = /\$\s*$/;

function mentionsNumberFormat(node) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["toFixed", "toLocaleString"].includes(current.expression.name.text)
    ) {
      found = true;
      return;
    }
    // A nested template or JSX is its own literal; its "$" is judged there.
    if (ts.isTemplateExpression(current) || ts.isJsxElement(current) || ts.isFunctionLike(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function flattenPlus(node, out = []) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    flattenPlus(node.left, out);
    flattenPlus(node.right, out);
  } else if (ts.isParenthesizedExpression(node)) {
    flattenPlus(node.expression, out);
  } else {
    out.push(node);
  }
  return out;
}

function countHandBuiltUsd(source, relativePath) {
  if (!/\$/.test(source) || !/\.(toFixed|toLocaleString)\(/.test(source)) return 0;
  const kind = relativePath.endsWith(".tsx") || relativePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, kind);
  let hits = 0;

  const visit = (node) => {
    if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span, index) => {
        const before = index === 0 ? node.head.text : node.templateSpans[index - 1].literal.text;
        if (DOLLAR_AT_END.test(before) && mentionsNumberFormat(span.expression)) hits += 1;
      });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      const operands = flattenPlus(node);
      for (let index = 0; index < operands.length - 1; index += 1) {
        const operand = operands[index];
        const isDollarLiteral =
          (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) &&
          DOLLAR_AT_END.test(operand.text);
        if (isDollarLiteral && mentionsNumberFormat(operands[index + 1])) hits += 1;
      }
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const children = node.children;
      for (let index = 0; index < children.length - 1; index += 1) {
        const text = children[index];
        const next = children[index + 1];
        if (
          ts.isJsxText(text) &&
          DOLLAR_AT_END.test(text.text) &&
          ts.isJsxExpression(next) &&
          next.expression &&
          mentionsNumberFormat(next.expression)
        ) {
          hits += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

export function measureUiUnification({ root = projectRoot, config }) {
  const scan = config.scan;
  const exportAllowlist = new Set(config.exportHelperAllowlist ?? []);
  const usdAllowlist = new Set(config.moneyHelperAllowlist ?? []);
  const measured = Object.fromEntries(CHECK_IDS.map((id) => [id, {}]));
  const files = collectFiles(root, scan);

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    const counts = {
      "native-confirm": countNativeConfirm(source),
      "raw-export": exportAllowlist.has(relativePath) ? 0 : countRawExport(source),
      "bare-page-title": relativePath.startsWith(scan.pagesRoot) ? countBarePageTitles(source) : 0,
      "component-state-tabs": countComponentStateTabs(source, relativePath, scan),
      "hand-built-usd": usdAllowlist.has(relativePath) ? 0 : countHandBuiltUsd(source, relativePath),
    };
    for (const id of CHECK_IDS) {
      if (counts[id] > 0) measured[id][relativePath] = counts[id];
    }
  }
  return { files: files.length, measured };
}

export function auditUiUnificationRatchet({ root = projectRoot, configPath } = {}) {
  const resolvedConfig = configPath ? path.resolve(configPath) : path.join(root, DEFAULT_CONFIG);
  const config = JSON.parse(fs.readFileSync(resolvedConfig, "utf8"));
  const { files, measured } = measureUiUnification({ root, config });
  const failures = [];
  const advisories = [];
  const totals = {};
  const relativeConfig = toPosix(path.relative(root, resolvedConfig));
  const configLabel = relativeConfig.startsWith("..") ? resolvedConfig : relativeConfig;

  for (const id of CHECK_IDS) {
    const baseline = config.baseline?.[id] ?? {};
    const current = measured[id];
    totals[id] = {
      measured: Object.values(current).reduce((sum, count) => sum + count, 0),
      baseline: Object.values(baseline).reduce((sum, count) => sum + count, 0),
      files: Object.keys(current).length,
    };
    for (const [file, count] of Object.entries(current)) {
      const allowed = baseline[file] ?? 0;
      if (count > allowed) {
        failures.push({
          check: id,
          file,
          count,
          allowed,
          message:
            allowed === 0
              ? `${file}: ${count} new ${CHECKS[id].title} hit(s) (file is not in the baseline).`
              : `${file}: ${count} ${CHECKS[id].title} hit(s), baseline is ${allowed}.`,
        });
      }
    }
    for (const [file, allowed] of Object.entries(baseline)) {
      const count = current[file] ?? 0;
      if (count < allowed) {
        advisories.push(
          `${id}: ${file} is down to ${count} from ${allowed} — lower baseline.${id}["${file}"] ` +
            `${count === 0 ? "by removing the entry" : `to ${count}`} in ${configLabel}.`
        );
      }
    }
  }

  return { files, measured, totals, failures, advisories, configPath: resolvedConfig };
}

function writeBaseline(report) {
  const config = JSON.parse(fs.readFileSync(report.configPath, "utf8"));
  config.baseline = Object.fromEntries(
    CHECK_IDS.map((id) => [
      id,
      Object.fromEntries(Object.entries(report.measured[id]).sort(([left], [right]) => left.localeCompare(right))),
    ])
  );
  fs.writeFileSync(report.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootArg = argValue("--root");
  const configArg = argValue("--config");
  const report = auditUiUnificationRatchet({
    root: rootArg ? path.resolve(rootArg) : projectRoot,
    configPath: configArg,
  });

  if (process.env.UPDATE_UI_UNIFICATION_BASELINE === "1") {
    writeBaseline(report);
    console.log(`UI unification baseline rewritten from ${report.files} file(s).`);
    process.exit(0);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.failures.length > 0 ? 1 : 0);
  }

  for (const advisory of report.advisories) console.warn(`WARNING: ${advisory}`);

  if (report.failures.length > 0) {
    console.error("\nUI unification ratchet failed:");
    for (const id of CHECK_IDS) {
      const failures = report.failures.filter((failure) => failure.check === id);
      if (failures.length === 0) continue;
      console.error(`\n[${id}] ${CHECKS[id].title}`);
      for (const failure of failures) console.error(`  ${failure.message}`);
      console.error(`  How to fix: ${CHECKS[id].fix}`);
    }
    console.error(
      "\nBaselines in config/ui-unification-ratchet.json may only fall. Move the new code onto the shared piece\n" +
        "instead of raising a count (see docs/ui-unification/plan.md)."
    );
    process.exitCode = 1;
  } else {
    const summary = CHECK_IDS.map((id) => `${id} ${report.totals[id].measured}/${report.totals[id].baseline}`).join(", ");
    console.log(`UI unification ratchet verified across ${report.files} files (current/baseline): ${summary}.`);
  }
}
