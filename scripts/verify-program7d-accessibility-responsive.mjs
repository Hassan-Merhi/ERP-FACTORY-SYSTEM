#!/usr/bin/env node
import fs from "node:fs";

const files = {
  responsive: "client/src/components/ui/responsive-accessibility.tsx",
  financial: "client/src/components/financial/financial-screen.tsx",
  operations: "client/src/components/operations/operations-screen.tsx",
  dialog: "client/src/components/ui/dialog.tsx",
  sheet: "client/src/components/ui/sheet.tsx",
  direction: "client/src/i18n/applicationDirection.ts",
  languageContext: "client/src/contexts/ApplicationLanguageContext.tsx",
  rtl: "client/src/styles/rtl-hardening.css",
  erpShell: "client/src/app/ErpShell.tsx",
  factoryShell: "client/src/app/FactoryShell.tsx",
  propertiesShell: "client/src/app/PropertiesShell.tsx",
  posShell: "client/src/app/PosShell.tsx",
  mobileHook: "client/src/hooks/use-mobile.tsx",
  mobileViewport: "client/src/mobile-browser-compat.css",
  main: "client/src/main.tsx",
};

const sources = Object.fromEntries(
  Object.entries(files).map(([name, path]) => [name, fs.readFileSync(path, "utf8")]),
);

const failures = [];

for (const token of [
  "SkipLink",
  "VisuallyHidden",
  "LiveRegion",
  "ResponsiveActions",
  "ResponsiveToolbar",
  "ResponsiveGrid",
  "AccessibleRegion",
  "HorizontalScrollRegion",
  "focus-visible:ring-2",
  "focus:ring-offset-2",
  "aria-label",
  "aria-live",
  "aria-atomic",
  "aria-describedby",
  'role="region"',
  'role="search"',
  'role="group"',
  "overflow-x-auto",
  "overscroll-x-contain",
  "max-w-full",
  "sm:flex-row",
  "auto-fit",
  "minmax",
  "motion-reduce:transition-none",
  'data-horizontal-scroll-region="true"',
]) {
  if (!sources.responsive.includes(token)) failures.push(`Responsive primitive contract missing: ${token}`);
}

for (const [name, source] of [
  ["financial", sources.financial],
  ["operations", sources.operations],
]) {
  for (const token of [
    "ResponsiveActions",
    "ResponsiveToolbar",
    "HorizontalScrollRegion",
    "aria-labelledby",
    "React.useId()",
    "wrap-break-word",
    "grid-cols-1",
  ]) {
    if (!source.includes(token)) failures.push(`${name} responsive screen contract missing: ${token}`);
  }
}

for (const token of [
  "overflow-y-auto",
  "overscroll-contain",
  "motion-reduce:animate-none",
  "motion-reduce:transition-none",
  'aria-label="Close dialog"',
  "VisuallyHidden",
  "*:w-full",
  'data-slot="dialog-content"',
  'data-slot="dialog-close"',
]) {
  if (!sources.dialog.includes(token)) failures.push(`Accessible dialog contract missing: ${token}`);
}

// The dialog is bounded by --app-viewport-height rather than a literal 100dvh. That variable is
// declared 100vh with an @supports (height: 100dvh) upgrade (asserted against the viewport CSS
// below), so it stays dvh-correct on mobile while still degrading on browsers without dvh.
if (!sources.dialog.includes("var(--app-viewport-height)")) {
  failures.push("Accessible dialog contract missing: dynamic viewport height bound");
}

for (const token of ['data-slot="sheet-content"', 'data-slot="sheet-close"', "data-sheet-side={side}", "motion-reduce:animate-none"]) {
  if (!sources.sheet.includes(token)) failures.push(`Accessible sheet contract missing: ${token}`);
}

// Touch targets are a floor, not an exact value: min-h-10/min-w-10 (40px) is the minimum, and the
// close controls may exceed it. Assert the floor so a larger target cannot fail the contract.
const MIN_TOUCH_TARGET_STEP = 10;
for (const [name, source] of [
  ["dialog", sources.dialog],
  ["sheet", sources.sheet],
]) {
  for (const axis of ["h", "w"]) {
    const steps = [...source.matchAll(new RegExp(`min-${axis}-(\\d+)`, "g"))].map((match) => Number(match[1]));
    if (!steps.some((step) => step >= MIN_TOUCH_TARGET_STEP)) {
      failures.push(`Accessible ${name} contract missing: min-${axis}-${MIN_TOUCH_TARGET_STEP} or larger touch target`);
    }
  }
}

for (const token of [
  "applyApplicationLanguageToDocument",
  "root.dataset.applicationLanguage",
  "root.dataset.applicationDirection",
  "targetDocument.body.dir = direction",
]) {
  if (!sources.direction.includes(token)) failures.push(`Application direction contract missing: ${token}`);
}

for (const token of [
  "applyApplicationLanguageToDocument(language)",
  "<LiveRegion",
  'data-testid="application-language-announcement"',
  "useApplicationDirection",
]) {
  if (!sources.languageContext.includes(token)) failures.push(`Language accessibility contract missing: ${token}`);
}

for (const token of [
  '[data-business-value]',
  '[data-account-code]',
  '[data-container-number]',
  '[data-voucher-number]',
  '[data-slot="sidebar-container"]',
  '[data-slot="dialog-close"]',
  '[data-slot="sheet-close"]',
  '[data-slot="app-top-bar-actions"]',
  '[data-slot="pos-top-bar-actions"]',
  '[data-directional-icon="true"]',
  "unicode-bidi: isolate",
  "direction: ltr",
  "pointer: coarse",
  "prefers-reduced-motion",
  "forced-colors",
]) {
  if (!sources.rtl.includes(token)) failures.push(`RTL hardening contract missing: ${token}`);
}

for (const [name, source] of [
  ["ERP", sources.erpShell],
  ["Factory", sources.factoryShell],
  ["Properties", sources.propertiesShell],
  ["POS", sources.posShell],
]) {
  for (const token of [
    "useApplicationLanguage",
    '<SkipLink>{t("accessibility.skipToMainContent")}</SkipLink>',
    'id="main-content"',
    "tabIndex={-1}",
  ]) {
    if (!source.includes(token)) failures.push(`${name} shell accessibility contract missing: ${token}`);
  }
}

for (const token of [
  'data-directional-icon="true"',
  'data-slot="pos-top-bar-actions"',
  'data-business-value="true"',
  'dir="auto"',
]) {
  if (!sources.posShell.includes(token)) failures.push(`POS RTL contract missing: ${token}`);
}

for (const token of [
  "const MOBILE_BREAKPOINT = 768",
  'typeof window.matchMedia !== "function"',
  'window.addEventListener("resize"',
  'mql.addEventListener("change"',
  "mql.addListener(onChange)",
  "mql.removeListener(onChange)",
]) {
  if (!sources.mobileHook.includes(token)) failures.push(`Mobile breakpoint compatibility contract missing: ${token}`);
}

for (const token of [
  "--app-viewport-height: 100vh",
  "@supports (height: 100dvh)",
  "--app-viewport-height: 100dvh",
  "@supports (height: 100svh)",
  "--app-viewport-height: 100svh",
  '[data-slot="sidebar-wrapper"]',
  '[data-slot="sidebar-container"]',
]) {
  if (!sources.mobileViewport.includes(token)) failures.push(`Mobile viewport compatibility contract missing: ${token}`);
}

if (!sources.main.includes('import "./mobile-browser-compat.css";')) {
  failures.push("Mobile viewport compatibility stylesheet is not loaded by main.tsx");
}

if (failures.length) {
  console.error("Program 7D accessibility and responsive verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Program 7D accessibility, responsive and RTL contracts verified.");
