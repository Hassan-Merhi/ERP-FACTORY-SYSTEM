import { spawnSync } from "node:child_process";

const skipTypeScript = process.env.PROGRAM6_SKIP_TYPESCRIPT === "1";

const commands = [
  ...(skipTypeScript ? [] : [["npm", ["run", "check"]]]),
  ["node", ["scripts/audit-company-scope.mjs", "--fail-on-findings"]],
  ["node", ["scripts/verify-security-wave3-closeout.mjs"]],
  [
    "node",
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/named-permission-service.test.ts",
      "tests/credential-version-service.test.ts",
      "tests/company-user-admin-scope-policy.test.ts",
      "tests/company-context-enforcement.test.ts",
      "tests/phase3-tenant-isolation-boundary.test.ts",
      "tests/phase33e-tenant-isolation-boundary.test.ts",
      "tests/global-maintenance-route-policy.test.ts",
      "tests/operational-permission-route-policy.test.ts",
      "tests/privileged-maintenance-route-policy.test.ts",
      "tests/legacy-privileged-write-guard.test.ts",
      "tests/raw-stock-sensitive-input-guard.test.ts",
      "tests/stored-file-protected-access.test.ts",
      "tests/program-5-end-to-end-security.test.ts",
      "tests/program-4-end-to-end-enforcement.test.ts",
      "tests/protected-asset-download-adapter.test.ts",
      "tests/security-audit-runtime.test.ts",
      "tests/security-headers-csp.test.ts",
      "tests/browser-mutation-security-boundary.test.ts",
      "tests/ws-broadcast-company-scope.test.ts",
      "server/lib/logRedaction.test.ts",
      "tests/transaction-company-scope-request-binding.test.ts",
      "tests/phase4-tenant-surface-regression.test.ts",
      "tests/database-scope-pool-binding.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism",
    ],
  ],
];

if (skipTypeScript) {
  console.log("Skipping duplicate TypeScript compilation; the CI static-build job already completed it.");
}

for (const [command, args] of commands) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NODE_ENV: "test" },
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\nProgram 6 + Phase 14 final security re-audit checks passed.");
