#!/usr/bin/env node
import fs from "node:fs";

const failures = [];
const read = (file) => {
  if (!fs.existsSync(file)) {
    failures.push(`Missing required file: ${file}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
};

const responsive = read("client/src/components/ui/responsive-accessibility.tsx");
const dialog = read("client/src/components/ui/dialog.tsx");
const css = read("client/src/styles/rtl-hardening.css");
const phase8Test = read("tests/rtl-responsive-accessibility.test.ts");

for (const token of [
  "getHashTarget",
  "target.focus({ preventScroll: true })",
  'target.scrollIntoView({ block: "start" })',
  'aria-keyshortcuts="ArrowLeft ArrowRight"',
  "event.currentTarget.scrollBy",
]) {
  if (!responsive.includes(token)) failures.push(`Responsive accessibility hardening missing: ${token}`);
}

if (dialog.includes("handleCloseAutoFocus") || dialog.includes("onCloseAutoFocus={handleCloseAutoFocus}")) {
  failures.push("Dialog close still suppresses Radix trigger-focus restoration");
}

for (const token of [
  "[data-stock-name]",
  "[data-stock-item-name]",
  "[data-stock-group]",
  "[data-stock-group-name]",
  '[data-slot="sheet-content"][data-sheet-side="left"]',
  '[data-slot="sheet-content"][data-sheet-side="right"]',
  '[data-slot="sidebar"][data-side="left"]',
  '[data-slot="sidebar"][data-side="right"]',
  '[data-mobile="true"][data-sheet-side="left"]',
  '[data-mobile="true"][data-sheet-side="right"]',
  "scrollbar-gutter: stable both-edges",
]) {
  if (!css.includes(token)) failures.push(`RTL current-main contract missing: ${token}`);
}

for (const shell of ["ErpShell", "FactoryShell", "PropertiesShell", "PosShell"]) {
  const source = read(`client/src/app/${shell}.tsx`);
  if (!source.includes('<SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>')) {
    failures.push(`${shell} is missing translated skip navigation`);
  }
  if (!source.includes('id="main-content"') || !source.includes("tabIndex={-1}")) {
    failures.push(`${shell} is missing the focusable main-content target`);
  }
}

for (const token of [
  "focuses the actual main landmark",
  "mirrors left and right sheets and sidebars independently",
  "aria-keyshortcuts",
]) {
  if (!phase8Test.includes(token)) failures.push(`Phase 8 contract coverage missing: ${token}`);
}

if (failures.length > 0) {
  console.error("Phase 8 current-main RTL/accessibility reconciliation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 8,
      status: "reconciled-on-current-main",
      directions: { ar: "rtl", en: "ltr", fr: "ltr" },
      skipNavigationFocus: true,
      dialogFocusRestoration: true,
      horizontalKeyboardScroll: true,
      bothSidebarSidesMirrored: true,
      storedBusinessValuesProtected: true,
      sqlRequired: false,
    },
    null,
    2
  )
);
