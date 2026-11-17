import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = path.join(repositoryRoot, "scripts", "audit-i18n.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "i18n-audit-classifier-"));

try {
  fs.mkdirSync(path.join(temporaryRoot, "client", "src", "i18n"), { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, "config"), { recursive: true });

  fs.writeFileSync(
    path.join(temporaryRoot, "client", "src", "Example.tsx"),
    `
const comparison = left > right ? 1 : 0;
const route = { message: "/api/example" };
const technical = new Error("validation");
export function Example() {
  return (
    <section>
      <button>Cancel</button>
      <button>Save this record</button>
      <input aria-label="Customer reference" />
    </section>
  );
}
`,
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "client", "src", "i18n", "sharedInterfaceTranslations.ts"),
    `export const values = [{ en: "Cancel", ar: "إلغاء", fr: "Annuler" }];\n`,
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "config", "i18n-audit-policy.json"),
    JSON.stringify(
      {
        roots: ["client/src"],
        extensions: [".ts", ".tsx"],
        ignoredDirectories: [],
        ignoredPathRules: [{ pattern: "(^|/)i18n(/|$)", reason: "translation source" }],
        protectedMarkers: ["data-no-translate"],
        moduleRules: [],
      },
      null,
      2,
    ),
  );

  const result = spawnSync(
    process.execPath,
    [
      auditScript,
      "--no-enforce",
      "--json-out",
      "artifacts/report.json",
      "--suggested-baseline-out",
      "artifacts/baseline.json",
    ],
    { cwd: temporaryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const report = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "artifacts", "report.json"), "utf8"));
  const byText = new Map(report.findings.map((finding) => [finding.text, finding]));

  assert.equal(byText.has("left > right ? 1 : 0"), false, "comparison operators must not look like JSX text");
  assert.equal(byText.get("Cancel")?.category, "compatibility-covered");
  assert.equal(byText.get("Save this record")?.status, "actionable");
  assert.equal(byText.get("Customer reference")?.status, "actionable");
  assert.equal(byText.get("/api/example")?.category, "technical-route");
  assert.equal(byText.get("validation")?.category, "technical-identifier");
  assert.equal(report.totals.unclassified, 0);

  console.log("I18n audit classifier contract verified.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
