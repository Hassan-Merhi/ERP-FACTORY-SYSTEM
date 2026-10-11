#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const table = await read("client/src/components/ui/table.tsx");
const pagination = await read("client/src/components/ui/pagination.tsx");
const dataList = await read("client/src/components/ui/responsive-data-list.tsx");
const accessibility = await read("client/src/components/ui/responsive-accessibility.tsx");
const failures = [];

for (const token of [
  'role="region"',
  'data-horizontal-scroll="true"',
  'data-table-scroll-region="true"',
  "aria-describedby",
  "touch-pan-x",
  "overscroll-x-contain",
  "focus-visible:ring-2",
  "minimumWidth",
  "sm:h-8",
  "sm:py-1",
]) {
  if (!table.includes(token)) failures.push(`Responsive table contract missing: ${token}`);
}

for (const token of [
  "overflow-x-auto",
  "min-w-max",
  "min-h-11 min-w-11",
  'className="hidden sm:inline"',
  'aria-label="Go to previous page"',
  'aria-label="Go to next page"',
]) {
  if (!pagination.includes(token)) failures.push(`Mobile pagination contract missing: ${token}`);
}

for (const token of [
  "ResponsiveDataList",
  "ResponsiveDataListItem",
  "ResponsiveDataListFields",
  "ResponsiveDataListField",
  "ResponsiveDataListActions",
  "ResponsiveDataListEmpty",
  'data-mobile-data-list="true"',
  "<dt",
  "<dd",
  "*:min-h-11",
]) {
  if (!dataList.includes(token)) failures.push(`Responsive data-list contract missing: ${token}`);
}

for (const token of [
  'data-horizontal-scroll="true"',
  'data-horizontal-scroll-region="true"',
  "aria-describedby",
  "touch-pan-x",
]) {
  if (!accessibility.includes(token)) failures.push(`Horizontal scroll contract missing: ${token}`);
}

for (const source of [table, pagination, dataList, accessibility]) {
  for (const forbidden of [
    "/api/",
    "useMutation(",
    "useQuery(",
    "queryClient",
    "ledgerAccount",
    "costPerKg",
    "stockQuantity",
  ]) {
    if (source.includes(forbidden)) failures.push(`Shared display primitive contains business logic: ${forbidden}`);
  }
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 5 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ phase: 5, status: "implemented", protectedContracts: 30 }, null, 2));
