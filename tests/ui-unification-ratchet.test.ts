import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditUiUnificationRatchet } from "../scripts/audit-ui-unification-ratchet.mjs";

const projectRoot = path.resolve(__dirname, "..");
const script = path.join(projectRoot, "scripts", "audit-ui-unification-ratchet.mjs");

const CHECK_IDS = ["native-confirm", "raw-export", "bare-page-title", "component-state-tabs", "hand-built-usd"];

// One violation per check, each in its own page file.
const VIOLATIONS: Record<string, string> = {
  "ConfirmPage.tsx": `export function ConfirmPage() {
  const remove = () => {
    if (!window.confirm("Delete?")) return;
  };
  return <button onClick={remove}>Delete</button>;
}
`,
  "ExportPage.tsx": `import * as XLSX from "xlsx-js-style";
export function ExportPage() {
  return <button onClick={() => XLSX.utils.book_new()}>Export</button>;
}
`,
  "TitlePage.tsx": `export function TitlePage() {
  return <h1 className="text-2xl">Stock</h1>;
}
`,
  "HubPage.tsx": `import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
export function HubPage() {
  const [tab, setTab] = useState("one");
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="one">One</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
`,
  "MoneyPage.tsx": `export function MoneyPage({ amount }: { amount: number }) {
  return <span>{\`$\${amount.toFixed(2)}\`}</span>;
}
`,
};

// Code that uses the shared pieces must not be counted.
const CLEAN = `import { useHubQueryState } from "@/hooks/useHubQueryState";
import { formatUsd } from "@/lib/moneyDisplay";
import type ExcelJS from "exceljs";
export function CleanPage({ amount, sheet }: { amount: number; sheet?: ExcelJS.Worksheet }) {
  const [tab, setTab] = useHubQueryState("tab", ["one"]);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <span>{formatUsd(amount)}</span>
      <span>{\`\${amount.toFixed(1)}%\`}</span>
      {sheet ? null : null}
    </Tabs>
  );
}
`;

const temporaryRoots: string[] = [];

function makeFixture(baseline: Record<string, Record<string, number>>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ui-unification-ratchet-"));
  temporaryRoots.push(root);
  const pagesDir = path.join(root, "client", "src", "pages");
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const [name, source] of Object.entries(VIOLATIONS)) fs.writeFileSync(path.join(pagesDir, name), source);
  fs.writeFileSync(path.join(pagesDir, "CleanPage.tsx"), CLEAN);
  // A test file with every violation is ignored.
  fs.writeFileSync(path.join(pagesDir, "ConfirmPage.test.tsx"), Object.values(VIOLATIONS).join("\n"));

  const configPath = path.join(root, "ratchet.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      scan: {
        root: "client/src",
        pagesRoot: "client/src/pages/",
        extensions: [".ts", ".tsx"],
        excludeDirectories: ["node_modules", "__tests__"],
      },
      exportHelperAllowlist: [],
      moneyHelperAllowlist: [],
      baseline,
    })
  );
  return { root, configPath };
}

function run(root: string, configPath: string) {
  return spawnSync(process.execPath, [script, "--root", root, "--config", configPath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("UI unification ratchet", () => {
  it("fails on one new violation in each check and names the fix", () => {
    const { root, configPath } = makeFixture({});
    const result = run(root, configPath);

    expect(result.status).toBe(1);
    for (const id of CHECK_IDS) expect(result.stderr.includes(`[${id}]`)).toBe(true);
    expect(result.stderr.includes("How to fix")).toBe(true);

    const report = auditUiUnificationRatchet({ root, configPath });
    const failed = report.failures.map((failure: { check: string; file: string }) => [failure.check, failure.file]);
    expect(failed.sort()).toEqual(
      [
        ["bare-page-title", "client/src/pages/TitlePage.tsx"],
        ["component-state-tabs", "client/src/pages/HubPage.tsx"],
        ["hand-built-usd", "client/src/pages/MoneyPage.tsx"],
        ["native-confirm", "client/src/pages/ConfirmPage.tsx"],
        ["raw-export", "client/src/pages/ExportPage.tsx"],
      ].sort()
    );
  });

  it("passes at the baseline and asks for the baseline to be lowered when a count falls", () => {
    const baseline = {
      "native-confirm": { "client/src/pages/ConfirmPage.tsx": 1 },
      "raw-export": { "client/src/pages/ExportPage.tsx": 1 },
      "bare-page-title": { "client/src/pages/TitlePage.tsx": 2 },
      "component-state-tabs": { "client/src/pages/HubPage.tsx": 1 },
      "hand-built-usd": { "client/src/pages/MoneyPage.tsx": 1 },
    };
    const { root, configPath } = makeFixture(baseline);
    const result = run(root, configPath);

    expect(result.status).toBe(0);
    expect(result.stderr.includes('lower baseline.bare-page-title["client/src/pages/TitlePage.tsx"] to 1')).toBe(true);
  });

  it("does not count a deliberately local tab list", () => {
    const { root, configPath } = makeFixture({});
    const hub = path.join(root, "client", "src", "pages", "HubPage.tsx");
    fs.writeFileSync(
      hub,
      VIOLATIONS["HubPage.tsx"].replace(
        "    <Tabs value",
        "    // ui-unification-local-tabs: dialog-only views\n    <Tabs value"
      )
    );
    const report = auditUiUnificationRatchet({ root, configPath });
    expect(report.measured["component-state-tabs"]).toEqual({});
  });

  it("passes on the repository at its committed baseline", () => {
    const result = spawnSync(process.execPath, [script], { cwd: projectRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.includes("UI unification ratchet verified")).toBe(true);
  });
});
