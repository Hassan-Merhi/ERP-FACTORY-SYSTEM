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

const files = Object.entries(summary)
  .filter(([file]) => file !== "total")
  .map(([file, metrics]) => {
    const relativePath = normalisePath(file);
    const lines = metrics.lines ?? { total: 0, covered: 0, pct: 100 };
    const branches = metrics.branches ?? { total: 0, covered: 0, pct: 100 };
    return {
      path: relativePath,
      category: categoryFor(relativePath),
      uncoveredLines: Math.max(0, lines.total - lines.covered),
      lineTotal: lines.total,
      lineCoveragePct: lines.pct,
      uncoveredBranches: Math.max(0, branches.total - branches.covered),
      branchTotal: branches.total,
      branchCoveragePct: branches.pct,
      zeroLineCoverage: lines.total > 0 && lines.covered === 0,
      zeroBranchCoverage: branches.total > 0 && branches.covered === 0,
    };
  })
  .filter((entry) => entry.path.startsWith("server/"));

const byGap = (a, b) =>
  b.uncoveredLines - a.uncoveredLines ||
  b.uncoveredBranches - a.uncoveredBranches ||
  a.path.localeCompare(b.path);
files.sort(byGap);

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
        top: entries
          .filter((entry) => entry.uncoveredLines > 0 || entry.uncoveredBranches > 0)
          .slice(0, limit),
      },
    ];
  })
);

const result = {
  generatedAt: new Date().toISOString(),
  sourceSha,
  source: input,
  totalCoverage: summary.total ?? null,
  rankingOrder: "uncoveredLines desc, uncoveredBranches desc, path asc",
  top: files
    .filter((entry) => entry.uncoveredLines > 0 || entry.uncoveredBranches > 0)
    .slice(0, limit),
  zeroCoverage: files
    .filter((entry) => entry.zeroLineCoverage || entry.zeroBranchCoverage)
    .slice(0, limit),
  categories: categorySummary,
};

function markdown(report) {
  const rows = report.top.map(
    (entry, index) =>
      `| ${index + 1} | ${entry.category} | \`${entry.path}\` | ${entry.uncoveredLines}/${entry.lineTotal} (${entry.lineCoveragePct}%) | ${entry.uncoveredBranches}/${entry.branchTotal} (${entry.branchCoveragePct}%) |`
  );
  const categoryRows = categories.map((category) => {
    const item = report.categories[category];
    return `| ${category} | ${item.files} | ${item.uncoveredLines} | ${item.uncoveredBranches} |`;
  });
  return [
    "# Backend coverage gap ranking",
    "",
    `Source: \`${report.source}\`${report.sourceSha ? ` at \`${report.sourceSha}\`` : ""}.`,
    `Ranking: ${report.rankingOrder}.`,
    "",
    "## Category totals",
    "",
    "| Category | Files | Uncovered lines | Uncovered branches |",
    "| --- | ---: | ---: | ---: |",
    ...categoryRows,
    "",
    `## Top ${report.top.length} files`,
    "",
    "| Rank | Category | File | Uncovered lines | Uncovered branches |",
    "| ---: | --- | --- | ---: | ---: |",
    ...rows,
    "",
    `Zero-line/zero-branch files are flagged in the JSON output; ${report.zeroCoverage.length} appear in the top-${limit} zero-coverage queue.`,
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
