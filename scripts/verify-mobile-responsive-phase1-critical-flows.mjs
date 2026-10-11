#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const browserCompat = await read("client/src/mobile-browser-compat.css");
const workspaceBoundary = await read("client/src/components/ui/workspace-route-boundary.tsx");
const erpShell = await read("client/src/app/ErpShell.tsx");
// The Agents page was split into pages/agents/* modules; the anchor markup
// (test ids and pane classes) now lives in the list/statement panels.
const agentsList = await read("client/src/pages/agents/AgentListPanel.tsx");
const agentsStatement = await read("client/src/pages/agents/AgentStatementPanel.tsx");
const accountGroups = await read("client/src/pages/AccountGroups.tsx");
const chat = await read("client/src/pages/Chat.tsx");
const rawStock = await read("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");
const indexCss = await read("client/src/index.css");

async function listTsx(dir) {
  const entries = await fs.readdir(path.join(ROOT, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath ?? entry.path, entry.name)));
}
const failures = [];

if (!browserCompat.includes("@media (max-width: 767px), (pointer: coarse)")) {
  failures.push("Critical mobile compatibility contract missing: @media (max-width: 767px), (pointer: coarse)");
}

// Since #2173 the phone stacking of these split-pane pages lives on the pages themselves as
// max-md: classes (so md+ is untouched by construction) instead of route-keyed rules in
// mobile-browser-compat.css. The same caps are pinned where they now live.
for (const [name, source, tokens] of [
  ["Agents (list panel)", agentsList, ["max-md:max-h-[min(42dvh,22rem)]", "max-md:flex-none"]],
  ["Account Groups", accountGroups, ["max-md:max-h-[min(44dvh,24rem)]", "max-md:flex-col"]],
  [
    "Chat",
    chat,
    [
      "max-md:max-h-[min(36dvh,20rem)]",
      "max-md:h-[calc(var(--app-viewport-height)-7rem)]",
      "max-md:overflow-hidden",
      "max-md:flex-col",
    ],
  ],
]) {
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${name} phone stacking contract missing: ${token}`);
  }
}

// Hover-revealed actions must stay visible on touch screens. #2173 replaced the global
// [class*="opacity-0"][class*="group-hover:opacity-100"] override with the `touch` variant on
// each control, so every such control is checked for its touch reveal.
if (!/@custom-variant touch \{\s*@media \(hover: none\) and \(pointer: coarse\)/.test(indexCss)) {
  failures.push("Touch variant contract missing: @custom-variant touch (hover: none) and (pointer: coarse)");
}
for (const file of await listTsx("client/src")) {
  const source = await read(file);
  for (const match of source.matchAll(/(?:className=|cn\()[^>]*?\bopacity-0\b[^>]*?group-hover:opacity-100[^>]*?(?=>|\n)/g)) {
    if (!match[0].includes("touch:opacity-100")) {
      failures.push(`Hover-only action without a touch reveal: ${file}`);
      break;
    }
  }
}

// The rule is about selectors, so the comments explaining why :has() is avoided
// must not themselves trip it — a whole-file substring check counts the prose as
// a violation and fails on a stylesheet that is actually compliant.
if (browserCompat.replace(/\/\*[\s\S]*?\*\//g, "").includes(":has(")) {
  failures.push("Critical mobile CSS must not use :has(); Firefox 110-120 is inside the supported baseline");
}

for (const token of ['data-workspace-route={routeKey}', 'routeKey={resetKey}']) {
  if (!workspaceBoundary.includes(token)) failures.push(`Workspace route marker contract missing: ${token}`);
}

for (const token of ['data-workspace-route={routePath}', 'data-erp-route={routePath}']) {
  if (!erpShell.includes(token)) failures.push(`ERP route wrapper contract missing: ${token}`);
}

for (const [name, source, tokens] of [
  ["Agents (list panel)", agentsList, ['data-testid="button-add-agent"', '"w-72 shrink-0']],
  ["Agents (statement panel)", agentsStatement, ['data-testid="text-agent-account-name"']],
  ["Account Groups", accountGroups, ['data-testid="button-create-group"', '"w-72 border-r flex flex-col shrink-0']],
  ["Chat", chat, ['data-testid="chat-page"', '"w-64 shrink-0 flex flex-col']],
]) {
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${name} selector anchor changed or disappeared: ${token}`);
  }
}

for (const token of [
  'opacity-0 group-hover:opacity-100 touch:opacity-100',
  'data-testid={`button-adjust-${row.supplierId}`}',
  'data-testid={`button-deduct-${row.supplierId}`}',
  'data-testid={`button-batch-${row.supplierId}`}',
]) {
  if (!rawStock.includes(token)) failures.push(`Raw Production touch-action anchor changed or disappeared: ${token}`);
}

if (failures.length > 0) {
  console.error("Mobile Phase 1 critical-flow verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: "mobile-repair-1",
      status: "implemented",
      protectedFlows: ["Agents", "Account Groups", "Chat", "touch hover actions"],
      firefoxBaselineSafe: true,
      desktopBreakpointPreserved: "md+",
      sqlRequired: false,
    },
    null,
    2,
  ),
);
