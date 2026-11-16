#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const shell = await read("client/src/app/PosShell.tsx");
const header = await read("client/src/pages/pos/pos-components/POSHeader.tsx");
const mobile = await read("client/src/pages/pos/pos-components/PosMobileLayout.tsx");
const transfers = await read("client/src/pages/pos/PosTransferOrders.tsx");
const failures = [];

for (const token of [
  'data-pos-shell="true"',
  'data-pos-workspace="true"',
  "max-sm:[&_button]:min-h-11",
  "max-sm:[&_input]:text-base",
  "pt-[max(0.5rem,env(safe-area-inset-top))]",
  "pb-[max(0.5rem,env(safe-area-inset-bottom))]",
]) {
  if (!shell.includes(token)) failures.push(`POS shell contract missing: ${token}`);
}

for (const token of [
  'data-pos-desktop-header="true"',
  'className="hidden px-4 pt-4 lg:block"',
  'data-pos-mobile-page="true"',
  'data-pos-mobile-checkout="true"',
  // #2173: the checkout bar sticks inside the POS scroller instead of being viewport-fixed, so
  // it never paints over a pinned tablet sidebar.
  "sticky bottom-0 z-40 mt-auto",
  "env(safe-area-inset-bottom)",
]) {
  const source = token.includes("desktop") || token.includes("hidden px") ? header : mobile;
  if (!source.includes(token)) failures.push(`POS layout split contract missing: ${token}`);
}

for (const token of [
  'role="combobox"',
  'aria-autocomplete="list"',
  'aria-controls={resultsId}',
  'role="listbox"',
  'aria-label="Matching stock items"',
  "max-h-[min(22rem,48dvh)]",
  "slice(0, 60)",
  "Decrease quantity for",
  "Increase quantity for",
  'data-testid="button-mobile-checkout"',
]) {
  if (!mobile.includes(token)) failures.push(`Mobile POS workflow contract missing: ${token}`);
}

for (const token of [
  'data-pos-transfer-orders="true"',
  'role="search"',
  'aria-label="Transfer order filters"',
  "sm:grid-cols-2",
  "min-h-11 w-full",
  "grid grid-cols-2 gap-2",
]) {
  if (!transfers.includes(token)) failures.push(`POS transfer order contract missing: ${token}`);
}

for (const [name, contents] of [
  ["shell", shell],
  ["header", header],
  ["mobile", mobile],
  ["transfers", transfers],
]) {
  for (const forbidden of ["adjustInventory", "ledgerAccountId:", "useMutation(", "apiRequest("]) {
    if (contents.includes(forbidden)) failures.push(`${name} contains forbidden business mutation token: ${forbidden}`);
  }
}

if (!mobile.includes("onClick={handleSaveSale}")) failures.push("Mobile checkout no longer calls the existing save handler");
if (
  !mobile.includes("saveMutation?.isPending") ||
  !mobile.includes("!hasValidItems") ||
  !mobile.includes("disabled={")
) {
  failures.push("Mobile checkout lost the existing pending/valid-items safeguard");
}
if (!transfers.includes('fetch(`/api/stock-transfers/list?${params}`')) {
  failures.push("Transfer-order query behavior changed");
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 8 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 8,
      status: "implemented",
      protectedContracts: 36,
      sqlRequired: false,
    },
    null,
    2
  )
);
