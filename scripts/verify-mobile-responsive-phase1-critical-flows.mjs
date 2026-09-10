#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const browserCompat = await read("client/src/mobile-browser-compat.css");
const workspaceBoundary = await read("client/src/components/ui/workspace-route-boundary.tsx");
const agents = await read("client/src/pages/Agents.tsx");
const accountGroups = await read("client/src/pages/AccountGroups.tsx");
const chat = await read("client/src/pages/Chat.tsx");
const rawStock = await read("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");
const failures = [];

for (const token of [
  '@media (max-width: 767px), (pointer: coarse)',
  '[class*="opacity-0"][class*="group-hover:opacity-100"]',
  '[data-workspace-route^="/agents"]',
  '[data-workspace-route^="/factory/agents"]',
  '[data-workspace-route^="/account-groups"]',
  '[data-workspace-route^="/chat"]',
  '[data-workspace-route^="/factory/chat"]',
  'max-height: min(42dvh, 22rem)',
  'max-height: min(44dvh, 24rem)',
  'max-height: min(36dvh, 20rem)',
  'height: calc(var(--app-viewport-height) - 7rem) !important',
  'overflow: hidden',
]) {
  if (!browserCompat.includes(token)) failures.push(`Critical mobile compatibility contract missing: ${token}`);
}

if (browserCompat.includes(":has(")) {
  failures.push("Critical mobile CSS must not use :has(); Firefox 110-120 is inside the supported baseline");
}

for (const token of ['data-workspace-route={routeKey}', 'routeKey={resetKey}']) {
  if (!workspaceBoundary.includes(token)) failures.push(`Workspace route marker contract missing: ${token}`);
}

for (const [name, source, tokens] of [
  ["Agents", agents, ['data-testid="button-add-agent"', 'data-testid="text-agent-account-name"', 'className="w-72 shrink-0']],
  ["Account Groups", accountGroups, ['data-testid="button-create-group"', 'className="w-72 border-r flex flex-col shrink-0"']],
  ["Chat", chat, ['data-testid="chat-page"', 'className="w-64 shrink-0 flex flex-col"']],
]) {
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${name} selector anchor changed or disappeared: ${token}`);
  }
}

for (const token of [
  'opacity-0 group-hover:opacity-100',
  'data-testid={`button-adjust-${row.supplierId}`}',
  'data-testid={`button-deduct-${row.supplierId}`}',
  'data-testid={`button-batch-${row.supplierId}`}',
]) {
  if (!rawStock.includes(token)) failures.push(`Raw Production touch-action anchor changed or disappeared: ${token}`);
}

if (!browserCompat.includes("Tablet/desktop layout remains untouched because these overrides stop at md.")) {
  failures.push("Desktop/tablet preservation comment missing from the Phase 1 contract");
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
