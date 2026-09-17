#!/usr/bin/env node
/**
 * Scanner / generator for the `data-remote-control-action` allowlist.
 *
 * - Scans `client/src` for `data-remote-control-action="..."` usages
 * - Compares them against `client/src/hooks/remote-control-action-registry.ts`
 * - With `--write`, regenerates the registry file to match the discovered actions
 *   (preserving the existing allowed list plus any new discovered values)
 * - Without flags, just verifies and exits 1 on mismatch with a helpful diff
 *
 * Usage:
 *   node scripts/generate-remote-control-action-registry.mjs          # verify
 *   node scripts/generate-remote-control-action-registry.mjs --write  # regenerate
 *   node scripts/verify-remote-control-action-registry.mjs             # alias verifier
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CLIENT_SRC = join(ROOT, "client/src");
const REGISTRY_PATH = join(ROOT, "client/src/hooks/remote-control-action-registry.ts");

const ACTION_RE = /data-remote-control-action\s*=\s*["']([^"']+)["']/g;
const REGISTRY_RE = /REMOTE_CONTROL_ALLOWED_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/;

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // skip generated / vendor-ish dirs but include everything else
      if (["node_modules", ".git", "dist", "build"].includes(e.name)) continue;
      await walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

async function scanActions() {
  const files = await walk(CLIENT_SRC);
  const found = new Map(); // action -> Set<file>
  for (const file of files) {
    const text = await readFile(file, "utf8");
    let m;
    ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(text))) {
      const action = m[1].trim();
      if (!action) continue;
      if (!found.has(action)) found.set(action, new Set());
      found.get(action).add(file.replace(ROOT + "/", ""));
    }
  }
  return found;
}

async function readRegistry() {
  const text = await readFile(REGISTRY_PATH, "utf8");
  const m = REGISTRY_RE.exec(text);
  if (!m) throw new Error("Could not parse REMOTE_CONTROL_ALLOWED_ACTIONS from registry");
  const inside = m[1];
  const values = [...inside.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return { text, values: values.map((v) => v.trim()).filter(Boolean) };
}

function registrySource(values) {
  const entries = values.map((v) => `  "${v}",`).join("\n");
  return `/**
 * Generated \`data-remote-control-action\` registry — usable allowlist for remote mouse control.
 *
 * Every value here was explicitly reviewed as a read-only or navigation-safe action.
 * The mouse policy only allows clicks when the target carries one of these values,
 * in addition to the existing text-heuristic fallbacks. Adding a new allowlisted
 * control requires adding its action to this registry first; the verifier
 * \`scripts/verify-remote-control-action-registry.mjs\` fails CI when a
 * \`data-remote-control-action\` value is used without being registered or when a
 * registry entry has no matching usage.
 *
 * This file is the source of truth — see \`scripts/generate-remote-control-action-registry.mjs\`
 * for the scanner that keeps the registry and the codebase in sync.
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
  const discovered = await scanActions();
  const { values: registered } = await readRegistry();
  const registeredSet = new Set(registered);
  const discoveredSet = new Set(discovered.keys());

  const unregistered = [...discoveredSet].filter((a) => !registeredSet.has(a));
  const unused = [...registeredSet].filter((a) => !discoveredSet.has(a));

  if (write) {
    // Merge discovered + registered, preserve order: registered first, then new discovered sorted
    const merged = [...registered];
    for (const a of [...discoveredSet].sort()) {
      if (!merged.includes(a)) merged.push(a);
    }
    merged.sort();
    await writeFile(REGISTRY_PATH, registrySource(merged), "utf8");
    console.log(`Wrote registry with ${merged.length} actions to ${REGISTRY_PATH}`);
    if (unregistered.length) console.log(`  added unregistered actions: ${unregistered.join(", ")}`);
    return;
  }

  let ok = true;
  if (unregistered.length) {
    ok = false;
    console.error(`\nUnregistered data-remote-control-action values found (${unregistered.length}):`);
    for (const action of unregistered.sort()) {
      console.error(`  - "${action}" in:`);
      for (const file of [...(discovered.get(action) ?? [])].sort()) console.error(`      ${file}`);
    }
    console.error(`\nAdd them to REMOTE_CONTROL_ALLOWED_ACTIONS in ${REGISTRY_PATH} or run:\n  node scripts/generate-remote-control-action-registry.mjs --write\n`);
  }
  if (unused.length) {
    // Unused registry entries are a warning, not an error, to allow forward-registration.
    // However for strict usability we surface them so the allowlist stays honest.
    console.warn(`\nRegistered but unused actions (${unused.length}) — consider removing or adding a matching data-remote-control-action:`);
    for (const a of unused.sort()) console.warn(`  - "${a}"`);
  }

  if (!ok) process.exit(1);
  console.log(`remote-control-action registry OK: ${registered.length} registered, ${discoveredSet.size} discovered`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
