#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--")) ?? "coverage/backend/coverage-summary.json";
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const limit = Number(valueFor("--limit") ?? 30);
const jsonOutput = valueFor("--json-output");
const markdownOutput = valueFor("--markdown-output");
const sourceSha = valueFor("--source-sha") ?? process.env.GITHUB_SHA ?? null;

if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
  throw new Error(`--limit must be an integer from 1 to 200; received ${String(limit)}`);
}
if (!fs.existsSync(input)) throw new Error(`Coverage summary not found: ${input}`);

const summary = JSON.parse(fs.readFileSync(input, "utf8"));
const workspaceMarkers = [
  "/ERP-FACTORY-SYSTEM/ERP-FACTORY-SYSTEM/",
  "\\ERP-FACTORY-SYSTEM\\ERP-FACTORY-SYSTEM\\",
];
const normalisePath = (file) => {
  let value = file.replaceAll("\\", "/");
  for (const marker of workspaceMarkers) {
    const normalizedMarker = marker.replaceAll("\\", "/");
    const index = value.lastIndexOf(normalizedMarker);
    if (index >= 0) value = value.slice(index + normalizedMarker.length);
  }
  return value.replace(/^.*?\/server\//, "server/");
};

const includesAny = (value, needles) => needles.some((needle) => value.includes(needle));
function categoryFor(file) {
  const lower = file.toLowerCase();
  if (
    includesAny(lower, [
      "/auth",
      "security",
      "permission",
      "session",
      "webauthn",
      "csrf",
      "login",
      "password",
    ])
  ) {
    return "Auth/Security";
  }
  if (
    includesAny(lower, [
      "/routes/sp/",
      "/routes/sp-",
      "supplier-partner",
      "supplierpartner",
      "/sp-migration/",
    ])
  ) {
    return "Supplier Partner";
  }
  if (
    includesAny(lower, [
      "import",
      "export",
      "spreadsheet",
      "xlsx",
      "excel",
      ".csv",
      "-pdf",
      "/pdf",
      "documentroutes",
    ])
  ) {
    return "Imports/Exports";
  }
  if (
    includesAny(lower, [
      "account",
      "ledger",
      "voucher",
      "journal",
      "daybook",
      "payroll",
      "financial",
      "finance",
      "profit",
      "cash-",
      "/cash",
      "bank",
      "reconciliation",
    ])
  ) {
    return "Accounting";
  }
  if (
    includesAny(lower, [
      "inventory",
      "/stock",
      "stock-",
      "bale",
      "raw-stock",
      "productionbale",
      "container-loaded-items",
      "offload",
    ])
  ) {
    return "Inventory";
  }
  if (lower.includes("/routes/factory/") || lower.includes("/services/factory-")) return "Factory";
  if (lower.startsWith("server/routes/")) return "ERP routes";
  return "Miscellaneous";
}

const zeroMetric = { total: 0, covered: 0, pct: 100 };
const files = Object.entries(summary)
  .filter(([file]) => file !== "total")
  .map(([file, metrics]) => {
    const relativePath = normalisePath(file);
    const lines = metrics.lines ?? zeroMetric;
    const branches = metrics.branches ?? zeroMetric;
    const functions = metrics.functions ?? zeroMetric;
    return {
      path: relativePath,
      category: categoryFor(relativePath),
      uncoveredLines: Math.max(0, lines.total - lines.covered),
      lineTotal: lines.total,
      lineCoveragePct: lines.pct,
      uncoveredBranches: Math.max(0, branches.total - branches.covered),
      branchTotal: branches.total,
      branchCoveragePct: branches.pct,
      uncoveredFunctions: Math.max(0, functions.total - functions.covered),
      functionTotal: functions.total,
      functionCoveragePct: functions.pct,
      zeroLineCoverage: lines.total > 0 && lines.covered === 0,
      zeroBranchCoverage: branches.total > 0 && branches.covered === 0,
      zeroFunctionCoverage: functions.total > 0 && functions.covered === 0,
    };
  })
  .filter((entry) => entry.path.startsWith("server/"));

const byBranches = (a, b) =>
  b.uncoveredBranches - a.uncoveredBranches ||
  b.uncoveredFunctions - a.uncoveredFunctions ||
  b.uncoveredLines - a.uncoveredLines ||
  a.path.localeCompare(b.path);
const byFunctions = (a, b) =>
  b.uncoveredFunctions - a.uncoveredFunctions ||
  b.uncoveredBranches - a.uncoveredBranches ||
  b.uncoveredLines - a.uncoveredLines ||
  a.path.localeCompare(b.path);

const branchRanking = files
  .filter((entry) => entry.uncoveredBranches > 0)
  .toSorted(byBranches)
  .slice(0, limit);
const functionRanking = files
  .filter((entry) => entry.uncoveredFunctions > 0)
  .toSorted(byFunctions)
  .slice(0, limit);

const categories = [
  "Accounting",
  "Inventory",
  "Factory",
  "ERP routes",
  "Auth/Security",
  "Imports/Exports",
  "Supplier Partner",
  "Miscellaneous",
];
const categorySummary = Object.fromEntries(
  categories.map((category) => {
    const entries = files.filter((entry) => entry.category === category);
    return [
      category,
      {
        files: entries.length,
        uncoveredLines: entries.reduce((sum, entry) => sum + entry.uncoveredLines, 0),
        uncoveredBranches: entries.reduce((sum, entry) => sum + entry.uncoveredBranches, 0),
        uncoveredFunctions: entries.reduce((sum, entry) => sum + entry.uncoveredFunctions, 0),
      },
    ];
  })
);

const result = {
  generatedAt: new Date().toISOString(),
  sourceSha,
  source: input,
  totalCoverage: summary.total ?? null,
  branchRankingOrder: "uncoveredBranches desc, uncoveredFunctions desc, uncoveredLines desc, path asc",
  functionRankingOrder: "uncoveredFunctions desc, uncoveredBranches desc, uncoveredLines desc, path asc",
  topBranches: branchRanking,
  topFunctions: functionRanking,
  zeroCoverage: files
    .filter((entry) => entry.zeroLineCoverage || entry.zeroBranchCoverage || entry.zeroFunctionCoverage)
    .toSorted(byBranches)
    .slice(0, limit),
  categories: categorySummary,
};

function tableRows(entries) {
  return entries.map(
    (entry, index) =>
      `| ${index + 1} | ${entry.category} | \`${entry.path}\` | ${entry.uncoveredBranches}/${entry.branchTotal} (${entry.branchCoveragePct}%) | ${entry.uncoveredFunctions}/${entry.functionTotal} (${entry.functionCoveragePct}%) | ${entry.uncoveredLines}/${entry.lineTotal} (${entry.lineCoveragePct}%) |`
  );
}

function markdown(report) {
  const categoryRows = categories.map((category) => {
    const item = report.categories[category];
    return `| ${category} | ${item.files} | ${item.uncoveredBranches} | ${item.uncoveredFunctions} | ${item.uncoveredLines} |`;
  });
  const header = [
    "| Rank | Category | File | Uncovered branches | Uncovered functions | Uncovered lines |",
    "| ---: | --- | --- | ---: | ---: | ---: |",
  ];
  return [
    "# Backend branch and function gap ranking",
    "",
    `Source: \`${report.source}\`${report.sourceSha ? ` at \`${report.sourceSha}\`` : ""}.`,
    "",
    "## Category totals",
    "",
    "| Category | Files | Uncovered branches | Uncovered functions | Uncovered lines |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...categoryRows,
    "",
    `## Top ${report.topBranches.length} branch gaps`,
    "",
    ...header,
    ...tableRows(report.topBranches),
    "",
    `## Top ${report.topFunctions.length} function gaps`,
    "",
    ...header,
    ...tableRows(report.topFunctions),
    "",
  ].join("\n");
}

const md = markdown(result);
if (jsonOutput) {
  fs.mkdirSync(path.dirname(jsonOutput), { recursive: true });
  fs.writeFileSync(jsonOutput, `${JSON.stringify(result, null, 2)}\n`);
}
if (markdownOutput) {
  fs.mkdirSync(path.dirname(markdownOutput), { recursive: true });
  fs.writeFileSync(markdownOutput, `${md}\n`);
}
if (!jsonOutput && !markdownOutput) process.stdout.write(`${md}\n`);
