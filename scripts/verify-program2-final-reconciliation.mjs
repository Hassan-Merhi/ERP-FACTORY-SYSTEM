import fs from "node:fs";
import { spawnSync } from "node:child_process";

const phaseVerifiers = [
  "scripts/verify-program2-accounting-foundation.mjs",
  "scripts/verify-program2-manual-vouchers.mjs",
  "scripts/verify-program2-payments-receipts.mjs",
  "scripts/verify-program2-pos-stock-transfers.mjs",
  "scripts/verify-program2-containers-freight.mjs",
  "scripts/verify-program2-supplier-partner.mjs",
  "scripts/verify-program2-payroll.mjs",
  "scripts/verify-program2-rentals.mjs",
];

const required = [
  "docs/archive/program-2-phase-1-accounting-foundation.md",
  "docs/archive/program-2-phase-2-manual-journals-vouchers.md",
  "docs/archive/program-2-phase-3-payments-receipts.md",
  "docs/archive/program-2-phase-4-pos-stock-transfers.md",
  "docs/archive/program-2-phase-5-containers-freight.md",
  "docs/archive/program-2-phase-6-supplier-partner.md",
  "docs/archive/program-2-phase-7-payroll.md",
  "docs/archive/program-2-phase-8-rentals.md",
  "docs/archive/program-2-phase-9-final-reconciliation.md",
  ...phaseVerifiers,
];

const missing = required.filter((path) => !fs.existsSync(path));
if (missing.length) {
  console.error("Program 2 final reconciliation failed. Missing files:");
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

for (const verifier of phaseVerifiers) {
  console.log(`Running ${verifier}...`);
  const result = spawnSync(process.execPath, [verifier], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Program 2 final reconciliation failed to execute ${verifier}:`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Program 2 final reconciliation failed because ${verifier} exited with status ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const completion = fs.readFileSync("docs/archive/program-2-phase-9-final-reconciliation.md", "utf8");
for (const phrase of [
  "company ownership",
  "historical currency",
  "deterministic request identity",
  "replay-safe compatibility effects",
  "exact edit/delete reversal",
  "specialized-workflow isolation",
  "Merge-order requirement",
  "Verification boundary",
]) {
  if (!completion.includes(phrase)) {
    console.error(`Program 2 final reconciliation failed. Missing invariant: ${phrase}`);
    process.exit(1);
  }
}

console.log("Program 2 final reconciliation verification passed.");