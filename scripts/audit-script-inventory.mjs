#!/usr/bin/env node
/**
 * audit-script-inventory.mjs
 *
 * Keeps scripts/ honest about what is actually enforced.
 *
 * Every verify-*.mjs and audit-*.mjs is classified as:
 *
 *   wired    — invoked by an automatic GitHub Actions workflow or CircleCI;
 *   manual   — exposed by package.json or a workflow_dispatch-only workflow,
 *              but not automatically enforced;
 *   chained  — invoked by another script/test only;
 *   orphan   — nothing invokes or exposes it.
 *
 * The distinction matters: an npm alias makes a script runnable, not a CI gate.
 * Automatic wired scripts must pass on a bare checkout unless their declared
 * environment dependency makes that impossible. Manual known-failing scripts
 * may be tracked, but they are forbidden from becoming automatic gates while
 * failing. Orphan count remains a falling ceiling.
 *
 * Usage:
 *   npm run audit:scripts
 *   node scripts/audit-script-inventory.mjs --json
 *   node scripts/audit-script-inventory.mjs --list
 *   UPDATE_SCRIPT_INVENTORY=1 node scripts/audit-script-inventory.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(projectRoot, "config/script-inventory.json");
const SELF = "audit-script-inventory.mjs";

function listScripts() {
  return fs
    .readdirSync(path.join(projectRoot, "scripts"))
    .filter((name) => /^(verify|audit)-.*\.mjs$/.test(name))
    .sort();
}

function walkTextFiles(root, out = new Map()) {
  const absolute = path.join(projectRoot, root);
  if (!fs.existsSync(absolute)) return out;
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) {
    try {
      out.set(root.split(path.sep).join("/"), fs.readFileSync(absolute, "utf8"));
    } catch {
      // Binary/unreadable files cannot invoke scripts.
    }
    return out;
  }

  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    walkTextFiles(path.join(root, entry.name), out);
  }
  return out;
}

function collectSources() {
  const ci = new Map();
  const chains = new Map();
  walkTextFiles(".github/workflows", ci);
  walkTextFiles(".circleci", ci);
  walkTextFiles("scripts", chains);
  walkTextFiles("tests", chains);
  return { ci, chains };
}

function workflowIsAutomatic(file, text) {
  if (file.startsWith(".circleci/")) return true;
  return /^\s*(?:push|pull_request|schedule):/m.test(text);
}

function packageAliases() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

function aliasesForScript(script, aliases) {
  const needle = `scripts/${script}`;
  return Object.entries(aliases)
    .filter(([, command]) => typeof command === "string" && command.includes(needle))
    .map(([name, command]) => ({ name, command }));
}

function aliasReferenced(text, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bnpm\\s+(?:run\\s+)?${escaped}(?:\\s|$)`).test(text);
}

function sourceReferencesScript(text, script, scriptAliases) {
  if (text.includes(script)) return true;
  return scriptAliases.some(({ name }) => aliasReferenced(text, name));
}

function classify(script, ciSources, chainSources, aliases) {
  const scriptAliases = aliasesForScript(script, aliases);
  const automatic = [];
  const manualWorkflows = [];
  const chains = [];

  for (const [file, text] of ciSources) {
    if (!sourceReferencesScript(text, script, scriptAliases)) continue;
    if (workflowIsAutomatic(file, text)) automatic.push(file);
    else manualWorkflows.push(file);
  }

  for (const [file, text] of chainSources) {
    if (file === `scripts/${script}`) continue;
    if (text.includes(script)) chains.push(file);
  }

  if (automatic.length) {
    return { bucket: "wired", invokedBy: automatic, manualWorkflows, chains, aliases: scriptAliases };
  }
  if (manualWorkflows.length || scriptAliases.length) {
    return {
      bucket: "manual",
      invokedBy: [...manualWorkflows, ...scriptAliases.map(({ name }) => `package.json#${name}`)],
      manualWorkflows,
      chains,
      aliases: scriptAliases,
    };
  }
  if (chains.length) return { bucket: "chained", invokedBy: chains, manualWorkflows, chains, aliases: [] };
  return { bucket: "orphan", invokedBy: [], manualWorkflows: [], chains: [], aliases: [] };
}

function packageInvocationArgs(script, scriptAliases) {
  for (const { command } of scriptAliases) {
    const marker = `scripts/${script}`;
    const index = command.indexOf(marker);
    if (index < 0) continue;
    const tail = command.slice(index + marker.length).trim();
    if (!tail) return [];
    return tail.split(/\s+/).filter(Boolean);
  }
  return [];
}

function directInvocationArgs(script, invokedBy, ciSources) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:node\\s+)?scripts/${escaped}([^\\n]*)`);
  for (const file of invokedBy) {
    const text = ciSources.get(file);
    if (!text) continue;
    const match = text.match(pattern);
    if (!match) continue;
    const tail = match[1]
      .replace(/\\\s*$/, "")
      .trim();
    // GitHub Actions expands this Bash array at runtime; it is not a literal Node argument.
    if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}$/.test(tail)) return [];
    return tail ? tail.split(/\s+/).filter(Boolean) : [];
  }
  return [];
}

function invocationArgs(script, entry, ciSources) {
  const packageArgs = packageInvocationArgs(script, entry.aliases ?? []);
  if (packageArgs.length) return packageArgs;
  return directInvocationArgs(script, entry.invokedBy ?? [], ciSources);
}

function executeScript(script, args) {
  return spawnSync(process.execPath, [path.join("scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function auditScriptInventory({ run = true } = {}) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const scriptsOnDisk = listScripts();
  const scriptSet = new Set(scriptsOnDisk);
  const environmentDependent = new Map(Object.entries(config.environmentDependent ?? {}));
  const knownFailing = new Map(Object.entries(config.knownFailing ?? {}));
  const aliases = packageAliases();
  const { ci, chains } = collectSources();
  const failures = [];
  const scripts = [];

  for (const [script, reason] of environmentDependent) {
    if (!scriptSet.has(script)) failures.push(`environmentDependent lists ${script}, but that script no longer exists.`);
    if (!String(reason ?? "").trim()) failures.push(`environmentDependent.${script} must explain why the script cannot run here.`);
  }
  for (const [script, reason] of knownFailing) {
    if (!scriptSet.has(script)) failures.push(`knownFailing lists ${script}, but that script no longer exists.`);
    if (!String(reason ?? "").trim()) failures.push(`knownFailing.${script} must explain the real outstanding failure.`);
  }

  for (const script of scriptsOnDisk) {
    const entry = classify(script, ci, chains, aliases);
    let passes = null;
    const needsExecution =
      run &&
      script !== SELF &&
      !environmentDependent.has(script) &&
      (entry.bucket === "wired" || knownFailing.has(script));

    if (needsExecution) {
      const result = executeScript(script, invocationArgs(script, entry, ci));
      passes = result.status === 0;
      if (entry.bucket === "wired" && !passes) {
        const detail = `${result.stderr || result.stdout || ""}`.trim().split("\n").slice(0, 3).join(" / ");
        failures.push(
          `scripts/${script} is automatically wired through ${entry.invokedBy.join(", ")} but exits non-zero: ${detail || "no output"}`
        );
      }
    }

    if (knownFailing.has(script)) {
      if (entry.bucket === "wired") {
        failures.push(
          `scripts/${script} is listed knownFailing but is now an automatic CI gate. Automatic gates may not be suppressed; fix the script or remove it from the automatic workflow.`
        );
      }
      if (passes === true) {
        failures.push(`scripts/${script} now passes but remains in knownFailing. Remove the stale exception.`);
      }
    }

    scripts.push({ script, ...entry, passes });
  }

  const orphans = scripts.filter((entry) => entry.bucket === "orphan");
  const ceiling = config.orphanCeiling;
  if (ceiling !== undefined && orphans.length > ceiling) {
    failures.push(
      `${orphans.length} verify/audit scripts are invoked or exposed by nothing; the ceiling is ${ceiling}. ` +
        `Wire it up, expose it intentionally, or delete it.`
    );
  }

  return {
    version: config.version,
    failures,
    scripts,
    summary: {
      total: scripts.length,
      wired: scripts.filter((entry) => entry.bucket === "wired").length,
      manual: scripts.filter((entry) => entry.bucket === "manual").length,
      chained: scripts.filter((entry) => entry.bucket === "chained").length,
      orphan: orphans.length,
      orphanCeiling: ceiling ?? null,
      environmentDependent: environmentDependent.size,
      knownFailing: knownFailing.size,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditScriptInventory();

  if (process.env.UPDATE_SCRIPT_INVENTORY === "1") {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.orphanCeiling = report.summary.orphan;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Orphan ceiling set to ${report.summary.orphan}.`);
    process.exit(0);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.failures.length > 0 ? 1 : 0);
  }

  if (process.argv.includes("--list")) {
    for (const bucket of ["wired", "manual", "chained", "orphan"]) {
      const entries = report.scripts.filter((entry) => entry.bucket === bucket);
      console.log(`\n${bucket} (${entries.length})`);
      for (const entry of entries) console.log(`  ${entry.script}`);
    }
    console.log("");
  }

  const { summary } = report;
  console.log(
    `Scripts: ${summary.total} — ${summary.wired} automatic gates, ${summary.manual} manual, ` +
      `${summary.chained} chained, ${summary.orphan} orphaned (ceiling ${summary.orphanCeiling}).`
  );

  if (report.failures.length > 0) {
    console.error(report.failures.join("\n"));
    process.exitCode = 1;
  }
}
