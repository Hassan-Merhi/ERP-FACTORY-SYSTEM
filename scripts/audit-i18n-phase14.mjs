import fs from "node:fs";
import path from "node:path";
import {
  buildReport,
  createSuggestedBaseline,
  enforceBaseline,
  renderMarkdown,
} from "./i18n-audit-lib.mjs";

const DETECTOR_VERSION = 9;
const compatibilityTranslationFiles = [
  "client/src/i18n/applicationTranslations.ts",
  "client/src/i18n/sharedInterfaceTranslations.ts",
  "client/src/i18n/accountingDocumentTranslations.ts",
  "client/src/i18n/sharedUiPhase3Translations.part1.ts",
  "client/src/i18n/sharedUiPhase3Translations.part2.ts",
  "client/src/i18n/sharedUiPhase3Translations.part3.ts",
  "client/src/i18n/sharedUiPhase3Translations.part4.ts",
  "client/src/i18n/sharedUiPhase3Translations.part5.ts",
  "client/src/i18n/sharedUiPhase3Translations.part6.ts",
  "client/src/i18n/sharedUiPhase3Translations.part7.ts",
  "client/src/i18n/phase3RemainingTranslations.part01.ts",
  "client/src/i18n/phase3RemainingTranslations.part02.ts",
  "client/src/i18n/phase3RemainingTranslations.part03.ts",
  "client/src/i18n/phase3RemainingTranslations.part04.ts",
  "client/src/i18n/phase3RemainingTranslations.part05.ts",
  "client/src/i18n/phase3RemainingTranslations.part06.ts",
  "client/src/i18n/phase3RemainingTranslations.part07.ts",
  "client/src/i18n/phase3RemainingTranslations.part08.ts",
  "client/src/i18n/phase3RemainingTranslations.part09.ts",
  "client/src/i18n/phase3RemainingTranslations.part10.ts",
  "client/src/i18n/phase3RemainingTranslations.part11.ts",
  "client/src/i18n/phase3RemainingTranslations.part12.ts",
  "client/src/i18n/phase3RemainingTranslations.part13.ts",
  "client/src/i18n/phase3RemainingTranslations.part14.ts",
  "client/src/i18n/phase3RemainingTranslations.part15.ts",
  "client/src/i18n/phase3RemainingTranslations.part16.ts",
  "client/src/i18n/phase3RemainingTranslations.part17.ts",
  "client/src/i18n/phase3RemainingTranslations.part18.ts",
  "client/src/i18n/phase3RemainingTranslations.part19.ts",
  "client/src/i18n/phase3RemainingTranslations.part20.ts",
  "client/src/i18n/phase3RemainingTranslations.part21.ts",
  "client/src/i18n/phase3RemainingTranslations.part22.ts",
  "client/src/i18n/phase3RemainingTranslations.part23.ts",
  "client/src/i18n/phase3RemainingTranslations.part24.ts",
  "client/src/i18n/phase3RemainingTranslations.part25.ts",
  "client/src/i18n/supplierPartnerPhase4Translations.part1.ts",
  "client/src/i18n/supplierPartnerPhase4Translations.part2.ts",
  "client/src/i18n/supplierPartnerPhase4Translations.part3.ts",
  "client/src/i18n/supplierPartnerPhase4Translations.part4.ts",
  "client/src/i18n/propertiesRentalsPhase5Translations.part1.ts",
  "client/src/i18n/propertiesRentalsPhase5Translations.part2.ts",
  "client/src/i18n/propertiesRentalsPhase5Translations.part3.ts",
  "client/src/i18n/reportsExportsPhase6Translations.part1.ts",
  "client/src/i18n/reportsExportsPhase6Translations.part2.ts",
  "client/src/i18n/reportsExportsPhase6Translations.part3.ts",
  "client/src/i18n/reportsExportsPhase6Translations.part4.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part1.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part2.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part3.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part4.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part5.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part6.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part7.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part8.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part9.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part10.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part11.ts",
  "client/src/i18n/backendMessagesPhase7Translations.part12.ts",
  "client/src/i18n/currentMainSupplierPartnerTranslations.ts",
  "client/src/i18n/remoteSupportPhase4Translations.ts",
  "client/src/i18n/remoteSupportPhase5Translations.ts",
  "client/src/i18n/remoteSupportPhase6Translations.ts",
  "client/src/i18n/factoryProductionPlannerTranslations.ts",
  "client/src/i18n/factoryInsuranceTranslations.ts",
  "client/src/i18n/posItemReplacement.applicationTranslations.ts",
  "client/src/i18n/supplierProfitCheckTranslations.ts",
];

const reviewedTechnicalValues = new Set([
  // Detector false positive: `requestJson<ControllerSessionsResponse>(...)` reads as JSX to the
  // scanner, so the generic call's function name surfaces as translatable text. It is an
  // identifier, never rendered.
  "requestJson",
  // Factory production code uses fetchJson as a local typed-request helper; it is never rendered.
  "fetchJson",
  // State-enum value used by ErpAccessBoundary; never rendered as user-facing copy.
  "error",
  // Prettier can split adjacent translated JSX expressions so the scanner sees closing/opening
  // JSX syntax as an object-property value. This sequence is never rendered as user-facing copy.
  ")}</span>{",
  "seg.isSkip ? (",
  "text-success",
  "text-warning",
  "v.1.9.HMD",
  "useSidebar must be used within a SidebarProvider.",
  "useCarousel must be used within a <Carousel />",
  "useFormField should be used within <FormField>",
  "useFormField should be used within <FormItem>",
  "useTheme must be used within ThemeProvider",
  "useChart must be used within a <ChartContainer />",
  "${landlordUnitNames.get(r.unitId) ??",
  "${unitNameById.get(r.unitId) ??",
  "new Date().toISOString().slice(0, 10) && (",
  "unit${row.unitId}${unit.unitNumber ?",
  // Detector false positive: this is a calculation expression embedded in a
  // customer table cell, not user-facing copy.
  "Math.abs(customer.balance ?? 0)",
]);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function writeOutput(file, content) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function decodeCompatibilityValue(quote, rawValue) {
  // Generated translation inventories serialize their English source with
  // JSON.stringify. Decode that one serialization layer before comparing it
  // with scanner findings so escaped newlines, Unicode escapes, and escaped
  // template markers match the actual source value rather than file encoding.
  if (quote === '"') {
    try {
      return JSON.parse(`"${rawValue}"`);
    } catch {
      // Fall through to the legacy quote decoder for hand-authored entries.
    }
  }
  return rawValue.replace(/\\(["'`\\])/g, "$1");
}

function loadCompatibilityCoveredValues() {
  const values = new Set();
  for (const file of compatibilityTranslationFiles) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\ben\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      values.add(decodeCompatibilityValue(match[1], match[2]).trim());
    }
  }
  return values;
}

function looksLikeCssClassList(value) {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const utility = /^(?:!?-?(?:bg|text|border|ring|fill|stroke|font|leading|tracking|p[trblxy]?|m[trblxy]?|w|min-w|max-w|h|min-h|max-h|gap|space-[xy]|rounded|shadow|opacity|z|top|right|bottom|left|inset|grid|col|row|flex|items|justify|content|self|place|overflow|overscroll|whitespace|break|truncate|cursor|select|pointer-events|transition|duration|ease|delay|transform|translate|scale|rotate|skew|origin|animate|object|aspect|columns|divide|outline|decoration|underline|line-clamp|sr-only|hidden|block|inline|absolute|relative|fixed|sticky|grow|shrink|basis|order|visible|invisible)(?:[-:\[\]/.%#\w]+)?|(?:hover|focus|active|disabled|checked|data|aria|dark|sm|md|lg|xl|2xl):.+)$/;
  return tokens.every((token) => utility.test(token));
}

function refineFinding(finding, compatibilityCoveredValues) {
  const value = finding.text.trim();
  if (finding.kind === "jsx-text") {
    if (value.includes("\n")) return null;
    if (!/^[A-Za-z][A-Za-z0-9\s,.'!?&/():%+\-–—…*#@]+$/.test(value)) return null;
    if (/\b(?:return|const|let|var|useState|useRef|Promise|forwardRef|interface|type|extends)\b/.test(value)) {
      return null;
    }
  }
  if (reviewedTechnicalValues.has(value)) {
    return { ...finding, status: "excluded", category: "technical-identifier" };
  }
  if (compatibilityCoveredValues.has(value)) {
    return { ...finding, status: "excluded", category: "compatibility-covered" };
  }
  if (looksLikeCssClassList(value)) {
    return { ...finding, status: "excluded", category: "style-token" };
  }
  if (finding.kind === "jsx-expression-text" && /(?:\\t|\\n|\t|\n)/.test(value)) {
    return { ...finding, status: "excluded", category: "sample-data" };
  }
  if (finding.kind === "error-constructor" && /^[a-z][a-z0-9_-]{1,50}$/.test(value)) {
    return { ...finding, status: "excluded", category: "technical-identifier" };
  }
  return finding;
}

function rebuildReport(report, compatibilityCoveredValues) {
  const findings = report.findings.map((finding) => refineFinding(finding, compatibilityCoveredValues)).filter(Boolean);
  const modules = {};
  const excludedCategories = {};
  const filesByActionableCount = {};
  for (const finding of findings) {
    modules[finding.module] ??= { candidates: 0, actionable: 0, excluded: 0 };
    modules[finding.module].candidates += 1;
    modules[finding.module][finding.status] += 1;
    if (finding.status === "excluded") {
      excludedCategories[finding.category] = (excludedCategories[finding.category] ?? 0) + 1;
    } else {
      filesByActionableCount[finding.file] = (filesByActionableCount[finding.file] ?? 0) + 1;
    }
  }
  const actionable = findings.filter((finding) => finding.status === "actionable").length;
  return {
    ...report,
    detectorVersion: DETECTOR_VERSION,
    totals: {
      candidates: findings.length,
      actionable,
      excluded: findings.length - actionable,
      unclassified: 0,
    },
    modules: Object.fromEntries(Object.entries(modules).sort(([left], [right]) => left.localeCompare(right))),
    excludedCategories: Object.fromEntries(
      Object.entries(excludedCategories).sort(([, left], [, right]) => right - left),
    ),
    topActionableFiles: Object.entries(filesByActionableCount)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 50)
      .map(([file, count]) => ({ file, count })),
    findings,
  };
}

const policyPath = argumentValue("--policy") ?? "config/i18n-audit-policy.json";
const baselinePath = argumentValue("--baseline") ?? "config/i18n-phase14-baseline.json";
const jsonOutput = argumentValue("--json-out");
const markdownOutput = argumentValue("--markdown-out");
const suggestedBaselineOutput = argumentValue("--suggested-baseline-out");
const noEnforce = process.argv.includes("--no-enforce");

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : null;
const compatibilityCoveredValues = loadCompatibilityCoveredValues();
const report = rebuildReport(buildReport(policy), compatibilityCoveredValues);

writeOutput(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
writeOutput(markdownOutput, renderMarkdown(report, baseline));
if (suggestedBaselineOutput) {
  writeOutput(suggestedBaselineOutput, `${JSON.stringify(createSuggestedBaseline(report), null, 2)}\n`);
}

console.log(
  `I18n audit: ${report.totals.actionable} actionable, ${report.totals.excluded} reviewed exclusions, ${report.totals.candidates} total candidates.`,
);
for (const [module, counts] of Object.entries(report.modules)) {
  console.log(`${module}: ${counts.actionable} actionable / ${counts.excluded} excluded`);
}

if (!noEnforce) {
  if (!baseline) {
    console.error(`Missing reviewed baseline: ${baselinePath}`);
    process.exit(1);
  }
  const errors = enforceBaseline(report, baseline);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    console.error("Run with --no-enforce and review the generated report before updating the baseline.");
    process.exit(1);
  }
}
