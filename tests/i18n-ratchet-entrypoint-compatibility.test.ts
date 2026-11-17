import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const loadReport = createRequire(import.meta.url);
const runner = path.join(process.cwd(), "scripts/run-i18n-pr-ratchet.mjs");
function audit(marker: string): string {
  return `import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("--json-out") + 1], JSON.stringify({ marker: ${JSON.stringify(marker)} }));
fs.writeFileSync(args[args.indexOf("--markdown-out") + 1], "fixture audit");
`;
}
function withRepository(baseAudit: string | null, check: (root: string, baseSha: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-entrypoint-compat-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "README.md"), "isolated audit fixture\n");
    if (baseAudit) fs.writeFileSync(path.join(root, baseAudit), audit("base"));
    git("init", "--quiet");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base fixture");
    const baseSha = git("rev-parse", "HEAD");
    fs.copyFileSync(runner, path.join(root, "scripts/run-i18n-pr-ratchet.mjs"));
    fs.writeFileSync(path.join(root, "scripts/audit-i18n.mjs"), audit("current"));
    fs.writeFileSync(
      path.join(root, "scripts/verify-i18n-pr-ratchet.mjs"),
      `import fs from "node:fs";
import { createRequire } from "node:module";
const loadReport = createRequire(import.meta.url);
const [base, current] = process.argv.slice(2).map(p => loadReport(p).marker);
fs.writeFileSync("comparison.json", JSON.stringify({ base, current }));
`
    );
    check(root, baseSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function run(root: string, baseSha: string) {
  return spawnSync(process.execPath, ["scripts/run-i18n-pr-ratchet.mjs", baseSha, "reports"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("localization ratchet across the audit filename rename", () => {
  it.each(["scripts/audit-i18n-phase14.mjs", "scripts/audit-i18n.mjs"])(
    "compares the current audit with the real base using %s",
    (baseAudit) => {
      withRepository(baseAudit, (root, baseSha) => {
        const result = run(root, baseSha);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(loadReport(path.join(root, "comparison.json"))).toEqual({
          base: "base",
          current: "current",
        });
      });
    }
  );

  it("fails closed when the base has neither supported audit entrypoint", () => {
    withRepository(null, (root, baseSha) => {
      const result = run(root, baseSha);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Base revision has no supported i18n audit entrypoint");
      expect(fs.existsSync(path.join(root, "comparison.json"))).toBe(false);
    });
  });
});
