#!/usr/bin/env node
/**
 * Scanner / generator for the remote-control allowlist and editable coverage.
 *
 * The registry is intentionally exact: every registered action must be used and
 * every discovered action must be registered. The verifier also requires at
 * least one explicit `data-remote-control-editable="true"` coverage path so the
 * keyboard classifier cannot regress back to mechanism-only/zero-content state.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CLIENT_SRC = join(ROOT, "client/src");
const REGISTRY_PATH = join(ROOT, "client/src/hooks/remote-control-action-registry.ts");

const ACTION_PATTERNS = [
  /data-remote-control-action\s*=\s*["']([^"']+)["']/g,
  /setAttribute\(\s*["']data-remote-control-action["']\s*,\s*["']([^"']+)["']\s*\)/g,
];
const EDITABLE_PATTERNS = [
  /data-remote-control-editable\s*=\s*["']true["']/g,
  /setAttribute\(\s*["']data-remote-control-editable["']\s*,\s*["']true["']\s*\)/g,
  // Fields are now annotated at runtime by annotateRemoteControlSurface
  // (remote-control-surface-coverage.ts), which owns the attribute per element.
  /setOwnedAnnotation\(\s*\w+\s*,\s*["']data-remote-control-editable["']/g,
];
const REGISTRY_RE = /REMOTE_CONTROL_ALLOWED_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/;

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "build"].includes(e.name)) continue;
      await walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) {
      // Tests deliberately use unregistered actions ("delete-everything") to prove
      // they are rejected; scanning them would put those fixtures into the
      // production allowlist on the next --write.
      out.push(full);
    }
  }
  return out;
}

async function scanCoverage() {
  const files = await walk(CLIENT_SRC);
  const actions = new Map();
  const editableFiles = new Set();
  let editableUsages = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const relative = file.replace(ROOT + "/", "");

    for (const pattern of ACTION_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const action = match[1].trim();
        if (!action) continue;
        if (!actions.has(action)) actions.set(action, new Set());
        actions.get(action).add(relative);
      }
    }

    for (const pattern of EDITABLE_PATTERNS) {
      pattern.lastIndex = 0;
      const matches = [...text.matchAll(pattern)];
      if (matches.length > 0) {
        editableUsages += matches.length;
        editableFiles.add(relative);
      }
    }
  }

  return { actions, editableUsages, editableFiles };
}

async function readRegistry() {
  const text = await readFile(REGISTRY_PATH, "utf8");
  const match = REGISTRY_RE.exec(text);
  if (!match) throw new Error("Could not parse REMOTE_CONTROL_ALLOWED_ACTIONS from registry");
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1].trim()).filter(Boolean);
  return { text, values };
}

function registrySource(values) {
  const entries = values.map((value) => `  "${value}",`).join("\n");
  return `/**
 * Generated \`data-remote-control-action\` registry — usable allowlist for remote mouse control.
 *
 * Every value here is actively used by a reviewed read-only or navigation-safe
 * control. The verifier keeps the registry exact: unregistered usages and stale
 * forward-registered values both fail CI so coverage cannot silently drift.
 */
export const REMOTE_CONTROL_ALLOWED_ACTIONS = [
${entries}
] as const;

export type RemoteControlAction = (typeof REMOTE_CONTROL_ALLOWED_ACTIONS)[number];

export const REMOTE_CONTROL_ACTION_SET = new Set<string>(REMOTE_CONTROL_ALLOWED_ACTIONS);

export function isRegisteredRemoteControlAction(action: string | null | undefined): boolean {
  return typeof action === "string" && REMOTE_CONTROL_ACTION_SET.has(action);
}

export function getRemoteControlAction(element: Element | null): string | null {
  if (!element) return null;
  const raw = element.getAttribute("data-remote-control-action");
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function describeRemoteControlActionRegistry(): string {
  return REMOTE_CONTROL_ALLOWED_ACTIONS.join(", ");
}
`;
}

async function main() {
  const write = process.argv.includes("--write");
  const { actions: discovered, editableUsages, editableFiles } = await scanCoverage();
  const { values: registered } = await readRegistry();
  const registeredSet = new Set(registered);
  const discoveredSet = new Set(discovered.keys());

  if (write) {
    const exact = [...discoveredSet].sort();
    await writeFile(REGISTRY_PATH, registrySource(exact), "utf8");
    console.log(`Wrote exact registry with ${exact.length} actions to ${REGISTRY_PATH}`);
    console.log(`Explicit editable coverage: ${editableUsages} usages across ${editableFiles.size} files`);
    return;
  }

  let ok = true;
  const unregistered = [...discoveredSet].filter((action) => !registeredSet.has(action));
  const unused = [...registeredSet].filter((action) => !discoveredSet.has(action));

  if (unregistered.length) {
    ok = false;
    console.error(`\nUnregistered data-remote-control-action values found (${unregistered.length}):`);
    for (const action of unregistered.sort()) {
      console.error(`  - "${action}" in:`);
      for (const file of [...(discovered.get(action) ?? [])].sort()) console.error(`      ${file}`);
    }
  }

  if (unused.length) {
    ok = false;
    console.error(`\nRegistered but unused actions found (${unused.length}):`);
    for (const action of unused.sort()) console.error(`  - "${action}"`);
  }

  if (editableUsages === 0) {
    ok = false;
    console.error("\nNo explicit data-remote-control-editable=\"true\" coverage was discovered.");
  }

  if (!ok) {
    console.error("\nRun node scripts/generate-remote-control-action-registry.mjs --write after reviewing new safe actions.\n");
    process.exit(1);
  }

  console.log(
    `remote-control coverage OK: ${registered.length} registered/discovered actions, ${editableUsages} editable annotations across ${editableFiles.size} files`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
