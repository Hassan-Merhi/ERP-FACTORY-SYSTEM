#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const failures = [];

const schedulerIndex = read("server/services/scheduler/index.ts");
const scheduledJobs = read("server/services/scheduler/scheduled-jobs.ts");
const recoveryState = read("server/services/scheduler/daily-export-state.ts");
const serverIndex = read("server/index.ts");

const requireText = (source, text, message) => {
  if (!source.includes(text)) failures.push(message);
};
const rejectText = (source, text, message) => {
  if (source.includes(text)) failures.push(message);
};
const rejectStaticImport = (source, specifier, message) => {
  if (source.includes(`from "${specifier}"`) || source.includes(`from '${specifier}'`)) {
    failures.push(message);
  }
};
const hasDynamicImport = (source, specifier) => {
  const doubleQuoted = `"${specifier}"`;
  const singleQuoted = `'${specifier}'`;
  let cursor = 0;

  while (cursor < source.length) {
    const importStart = source.indexOf("import(", cursor);
    if (importStart === -1) return false;

    const importEnd = source.indexOf(")", importStart + "import(".length);
    if (importEnd === -1) return false;

    const argument = source.slice(importStart + "import(".length, importEnd).trim();
    if (argument === doubleQuoted || argument === singleQuoted) return true;

    cursor = importEnd + 1;
  }

  return false;
};
const requireDynamicImport = (source, specifier, message) => {
  if (!hasDynamicImport(source, specifier)) failures.push(message);
};

// server/index.ts may keep its stable scheduler API, but the scheduler barrel
// itself must no longer evaluate every job module at process startup.
requireText(
  serverIndex,
  'from "./services/scheduler"',
  "server startup must keep using the scheduler entrypoint"
);
rejectText(
  schedulerIndex,
  'export * from "./daily-export"',
  "scheduler entrypoint must not eagerly re-export daily-export"
);
rejectText(
  schedulerIndex,
  'export * from "./stock-report"',
  "scheduler entrypoint must not eagerly re-export stock-report"
);
rejectText(
  schedulerIndex,
  'export * from "./net-position"',
  "scheduler entrypoint must not eagerly re-export net-position"
);
rejectText(
  schedulerIndex,
  'export * from "./maintenance"',
  "scheduler entrypoint must not eagerly re-export maintenance"
);
requireDynamicImport(
  schedulerIndex,
  "./location-stock-report",
  "per-minute location-stock work must lazy-load its implementation"
);
requireDynamicImport(
  schedulerIndex,
  "./daily-export-state",
  "startup recovery must use the lightweight recovery probe"
);
requireDynamicImport(
  schedulerIndex,
  "./maintenance",
  "manual WhatsApp scheduler API must lazy-load maintenance"
);

for (const [specifier, label] of [
  ["../../routes/rental/shared", "rental accrual"],
  ["../accounting/scheduledConvergenceReconciliation", "convergence reconciliation"],
  ["./daily-export", "daily export"],
  ["./maintenance", "maintenance"],
  ["./net-position", "net position"],
  ["./stock-report", "stock report"],
]) {
  rejectStaticImport(
    scheduledJobs,
    specifier,
    `${label} implementation must not be a static scheduled-jobs import`
  );
  requireDynamicImport(
    scheduledJobs,
    specifier,
    `${label} implementation must remain dynamically loaded by its tick`
  );
}

// Schedule expressions are part of behavior. Keep the scheduler verifier aligned
// with the intentional daily rental-accrual catch-up while preserving every other
// Phase 2 scheduling invariant. The six-hourly container-tracking schedule is
// gone: automated carrier tracking was permanently disabled (66c6aa5).
for (const cronExpression of [
  '"0 7 1 * *"',
  '"0 6 * * *"',
  '"0 * * * *"',
  '"30 3 * * *"',
  '"0 9 * * *"',
  '"0 2 * * *"',
]) {
  requireText(scheduledJobs, cronExpression, `scheduler cron expression changed: ${cronExpression}`);
}
requireText(
  schedulerIndex,
  'cron.schedule("* * * * *", locationStockTick)',
  "location-stock every-minute registration must remain unchanged"
);

// The recovery probe itself must stay small and only cross into the heavy
// export graph when a missed/failed run really needs execution.
requireDynamicImport(
  recoveryState,
  "./daily-export",
  "daily export must load only after recovery state checks pass"
);
for (const heavyMarker of [
  'from "archiver"',
  "generateNetPositionExcel",
  "sendExportEmail",
  "runDailyWhatsAppSend",
  "createScheduledExportArtifact",
]) {
  rejectText(recoveryState, heavyMarker, `recovery probe must not retain heavy dependency: ${heavyMarker}`);
}

if (failures.length) {
  console.error("Render Phase 2 lazy-scheduler verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Render Phase 2 lazy-scheduler residency boundaries verified.");
