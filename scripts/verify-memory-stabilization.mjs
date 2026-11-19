#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const checks = [
  ["Export buffer audit", "scripts/audit-large-export-buffers.mjs"],
  ["Heavy API audit", "scripts/audit-heavy-list-endpoints.mjs"],
  ["Phase 9 export bridge", "scripts/verify-export-bridge.mjs"],
  ["Phase 10 scheduled attachments", "scripts/verify-scheduled-attachments.mjs"],
  ["Phase 11 API pagination", "scripts/verify-api-pagination.mjs"],
  ["Phase 11 native pagination", "scripts/verify-native-pagination.mjs"],
  ["Phase 11 stock-entry frontend", "scripts/verify-frontend-pagination.mjs"],
  ["Phase 11 V5 frontend", "scripts/verify-v5-frontend-pagination.mjs"],
  ["Phase 11 Daybook frontend", "scripts/verify-daybook-frontend-pagination.mjs"],
];

const startedAt = Date.now();
const results = [];

for (const [name, script] of checks) {
  process.stdout.write(`\n[stabilization] ${name}\n`);
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const status = result.status ?? 1;
  results.push({ name, script, status });
  if (status !== 0) {
    console.error(`\n[stabilization] FAILED: ${name} (${script})`);
    console.error(
      JSON.stringify(
        {
          ok: false,
          failed: { name, script, status },
          completed: results.filter((entry) => entry.status === 0).map((entry) => entry.name),
          durationMs: Date.now() - startedAt,
        },
        null,
        2
      )
    );
    process.exit(status);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: results.map(({ name, script }) => ({ name, script })),
      durationMs: Date.now() - startedAt,
      note: "This targeted runner does not execute typecheck, build, tests, CI, deployment, or migrations.",
    },
    null,
    2
  )
);
