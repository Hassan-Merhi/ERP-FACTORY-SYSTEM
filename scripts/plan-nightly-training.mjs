/**
 * Nightly diff classifier. Fails closed on bad revisions and unknown paths.
 * Reused-workflow caller supplies a full git history and the last successful
 * *nightly* run SHA, or leaves the baseline empty for the initial full audit.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const TOPICS = [
  "factory-overview", "factory-stock-entry", "factory-raw-materials",
  "factory-bale-explorer", "factory-containers", "factory-stock-allocation",
  "factory-invoicing", "factory-payroll", "factory-accounts", "factory-analytics",
  "erp-tracking", "erp-inventory", "erp-pos", "erp-vouchers",
  "erp-daybook", "erp-reports",
];
const ALL = new Set(TOPICS);
const names = {
  stockEntry: "factory-stock-entry", raw: "factory-raw-materials",
  bales: "factory-bale-explorer", container: "factory-containers",
  allocation: "factory-stock-allocation", invoice: "factory-invoicing",
  payroll: "factory-payroll", account: "factory-accounts",
  analytics: "factory-analytics",
};
function classify(files) {
  const chosen = new Set();
  let unknownRoutes = [];
  const all = () => TOPICS.forEach((id) => chosen.add(id));
  for (const f of files) {
    if (/^(training\/|client\/src\/training\/|scripts\/record-training-guides\.mjs|scripts\/training-screen\.mjs|scripts\/seed-training-demo-data\.mjs|scripts\/prepare-phase7-browser-e2e-fixture\.mjs|scripts\/training-narration(?:-tts)?\.(?:mjs|py)|\.github\/workflows\/training-videos\.yml|\.github\/workflows\/nightly-training-audit\.yml|shared\/factoryAccessRegistry\.ts)/.test(f)) { all(); continue; }
    if (/^(client\/src\/(?:app|components|contexts|hooks|routes|lib|styles)\/|server\/|shared\/|package(?:-lock)?\.json|vite\.config)/.test(f)) { all(); continue; }
    if (f.startsWith("client/src/pages/factory/")) {
      const lower = f.toLowerCase();
      const found = Object.entries(names).filter(([part]) => lower.includes(part.toLowerCase())).map(([, topic]) => topic);
      if (found.length) found.forEach((id) => chosen.add(id));
      else { TOPICS.filter((id) => id.startsWith("factory-")).forEach((id) => chosen.add(id)); unknownRoutes.push(f); }
      continue;
    }
    if (f.startsWith("client/src/pages/")) {
      if (/helptraining|login/i.test(f)) all();
      else {
        const lower = f.toLowerCase();
        if (/stock|inventory/i.test(lower)) chosen.add("erp-inventory");
        else if (/pos/i.test(lower)) chosen.add("erp-pos");
        else if (/voucher|daybook|account/i.test(lower)) { chosen.add("erp-vouchers"); chosen.add("erp-daybook"); }
        else if (/report|analytic/i.test(lower)) chosen.add("erp-reports");
        else { TOPICS.filter((id) => id.startsWith("erp-")).forEach((id) => chosen.add(id)); unknownRoutes.push(f); }
      }
    } else if (/^docs\/(?:onboarding|factory-flow|accounting-flow|inventory-flow|pos-flow|erp-navigation-registry|factory-navigation-registry)\.md$/.test(f)) all();
  }
  return { topics: TOPICS.filter((id) => chosen.has(id)), unknownRoutes };
}
const baseline = process.env.TRAINING_BASELINE_SHA?.trim() || "";
const head = process.env.GITHUB_SHA || "HEAD";
if (baseline && !/^[0-9a-f]{40}$/.test(baseline)) throw new Error("Invalid baseline commit SHA");
let files = [];
if (baseline) {
  execFileSync("git", ["cat-file", "-e", baseline + "^{commit}"]);
  files = execFileSync("git", ["diff", "--name-only", baseline, head], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
const plan = baseline ? classify(files) : { topics: TOPICS, unknownRoutes: [] };
const payload = {
  baseline: baseline || null, head, inspectedPaths: files.length,
  changedFiles: files, selectedTopics: plan.topics, unknownRoutes: plan.unknownRoutes,
  reason: !baseline ? "first full nightly recording" : plan.topics.length ? "source changed" : "no affected modules",
};
fs.mkdirSync("artifacts/training-plan", { recursive: true });
fs.writeFileSync("artifacts/training-plan/plan.json", JSON.stringify(payload, null, 2));
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, "record=" + String(plan.topics.length > 0) + "\n");
  // Any change that needs new recordings re-records every page the training
  // companies expose (discovered from their navigation), split across shards.
  fs.appendFileSync(process.env.GITHUB_OUTPUT, "topics=" + (plan.topics.length ? "all-pages" : "") + "\n");
}
console.log(JSON.stringify(payload, null, 2));
