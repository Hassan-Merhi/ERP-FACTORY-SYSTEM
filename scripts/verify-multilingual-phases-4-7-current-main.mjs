#!/usr/bin/env node
import fs from "node:fs";

const failures = [];
const read = (file) => fs.readFileSync(file, "utf8");
const requireFile = (file) => {
  if (!fs.existsSync(file)) {
    failures.push(`Missing required file: ${file}`);
    return "";
  }
  return read(file);
};

const translator = requireFile("client/src/components/ApplicationInterfaceTranslator.tsx");
const audit = requireFile("scripts/audit-i18n-phase14.mjs");
const backendAggregator = requireFile("client/src/i18n/backendMessagesPhase7Translations.ts");
const backendPart9 = requireFile("client/src/i18n/backendMessagesPhase7Translations.part9.ts");
const backendPart10 = requireFile("client/src/i18n/backendMessagesPhase7Translations.part10.ts");
const backendPart11 = requireFile("client/src/i18n/backendMessagesPhase7Translations.part11.ts");
const backendPart12 = requireFile("client/src/i18n/backendMessagesPhase7Translations.part12.ts");

const bundles = [
  {
    phase: 4,
    name: "Supplier Partner",
    aggregator: "client/src/i18n/supplierPartnerPhase4Translations.ts",
    parts: 4,
    translatorImport: "translatePhase4SupplierPartnerText",
    test: "tests/phase4-supplier-partner-translations.test.ts",
    expectedCount: 241,
  },
  {
    phase: 5,
    name: "Properties and Rentals",
    aggregator: "client/src/i18n/propertiesRentalsPhase5Translations.ts",
    parts: 3,
    translatorImport: "translatePhase5PropertiesRentalsText",
    test: "tests/phase5-properties-rentals-translations.test.ts",
    expectedCount: 182,
  },
  {
    phase: 6,
    name: "Reports and Exports",
    aggregator: "client/src/i18n/reportsExportsPhase6Translations.ts",
    parts: 4,
    translatorImport: "translatePhase6ReportsExportsText",
    test: "tests/phase6-reports-exports-translations.test.ts",
    expectedCount: 254,
  },
  {
    phase: 7,
    name: "Backend Messages",
    aggregator: "client/src/i18n/backendMessagesPhase7Translations.ts",
    parts: 12,
    translatorImport: "translatePhase7BackendMessageText",
    test: "tests/phase7-backend-messages-translations.test.ts",
    // The current mainline catalogue contains the reviewed backend-message
    // entries recorded by the Phase 7 translation contract.
    expectedCount: 643,
  },
];

for (const bundle of bundles) {
  const source = requireFile(bundle.aggregator);
  const test = requireFile(bundle.test);
  const base = bundle.aggregator.replace(/Translations\.ts$/, "Translations");

  for (let part = 1; part <= bundle.parts; part += 1) {
    const partFile = `${base}.part${part}.ts`;
    requireFile(partFile);
    if (!source.includes(`.part${part}`)) {
      failures.push(`${bundle.name} aggregator is not wired to part ${part}`);
    }
  }

  if (!translator.includes(bundle.translatorImport)) {
    failures.push(`${bundle.name} is not wired into ApplicationInterfaceTranslator`);
  }
  if (!test.includes(`toHaveLength(${bundle.expectedCount})`)) {
    failures.push(`${bundle.name} reviewed-count contract must be ${bundle.expectedCount}`);
  }
}

for (const protectedToken of [
  '"[data-business-value]"',
  '"[data-stock-name]"',
  '"[data-stock-group]"',
  '"[data-account-name]"',
  '"[data-article-code]"',
  '"[data-container-number]"',
  '"[data-voucher-number]"',
  '"[data-property-name]"',
  '"[data-unit-name]"',
  '"[data-tenant-name]"',
  '"[data-contract-reference]"',
]) {
  if (!translator.includes(protectedToken)) {
    failures.push(`Stored business-value translation exclusion missing: ${protectedToken}`);
  }
}

for (const token of [
  'import { backendMessagesPhase7TranslationsPart9 }',
  '...backendMessagesPhase7TranslationsPart9',
  "MAX_NESTED_CAPTURE_DEPTH",
  "translateCapturedValue",
  "translateNormalizedValue",
  'staticText.includes("→")',
]) {
  if (!backendAggregator.includes(token)) {
    failures.push(`Backend nested-message reconciliation missing: ${token}`);
  }
}

for (const [part, source] of [
  [10, backendPart10],
  [11, backendPart11],
  [12, backendPart12],
]) {
  if (!source.includes("export const backendMessagesPhase7TranslationsPart")) {
    failures.push(`Backend Messages part ${part} does not export its reviewed translation bundle`);
  }
}

for (const token of [
  'en: "start"',
  'fr: "début"',
  'en: "today"',
  'fr: "aujourd’hui"',
  'en: "(full history)"',
  'fr: "(historique complet)"',
  'en: "(${skipped.length} skipped)"',
  'fr: "({0} ignorée(s))"',
]) {
  if (!backendPart9.includes(token)) {
    failures.push(`Backend fragment translation missing: ${token}`);
  }
}

if (!audit.includes('"client/src/i18n/backendMessagesPhase7Translations.part9.ts"')) {
  failures.push("Phase 7 part 9 is missing from the multilingual audit coverage list");
}

const backendTest = requireFile("tests/phase7-backend-messages-translations.test.ts");
for (const token of [
  "(début → aujourd’hui)",
  "(1 ignorée(s))",
  "(السجل الكامل)",
]) {
  if (!backendTest.includes(token)) {
    failures.push(`Nested backend translation contract missing: ${token}`);
  }
}

if (failures.length > 0) {
  console.error("Multilingual Phases 4–7 current-main reconciliation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phases: bundles.map((bundle) => bundle.phase),
      status: "reconciled-on-current-main",
      languages: ["en", "ar", "fr"],
      reviewedEntries: bundles.reduce((total, bundle) => total + bundle.expectedCount, 0),
      storedBusinessValuesProtected: true,
      sqlRequired: false,
    },
    null,
    2
  )
);
