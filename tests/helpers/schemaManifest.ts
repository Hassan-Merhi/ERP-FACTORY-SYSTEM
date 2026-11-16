/**
 * Assertions against the committed schema manifest (migrations/manifest/schema.tsv).
 *
 * The manifest is the catalog a database built from migrations/ alone must have
 * (CI rebuilds it from an empty database and fails if it is stale). Tests that
 * used to assert "the runtime DDL in file X creates object Y" assert here that
 * the migrations define Y instead: the schema is no longer created at runtime.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseSnapshot } from "../../server/schema/schemaCatalog.mjs";

type ManifestEntry = { kind: string; identity: string; def: Record<string, unknown> & { def?: string }; raw: string };

let cache: ManifestEntry[] | null = null;

export function schemaManifest(): ManifestEntry[] {
  if (!cache) {
    const file = path.resolve(import.meta.dirname, "../../migrations/manifest/schema.tsv");
    cache = parseSnapshot(readFileSync(file, "utf8").split("\n")) as ManifestEntry[];
  }
  return cache;
}

const qualify = (identity: string) => (identity.includes(".") ? identity : `public.${identity}`);

/** The manifest entry for `kind` + identity, e.g. ("table", "vouchers"), ("column", "vouchers.company_id"). */
export function manifestEntry(kind: string, identity: string): ManifestEntry | undefined {
  const wanted = kind === "function" ? qualify(identity) : qualify(identity);
  return schemaManifest().find(
    (entry) =>
      entry.kind === kind &&
      (entry.identity === wanted || (kind === "function" && entry.identity.startsWith(`${wanted}(`)))
  );
}

export function hasTable(table: string): boolean {
  return Boolean(manifestEntry("table", table));
}

export function hasColumn(table: string, column: string): boolean {
  return Boolean(manifestEntry("column", `${qualify(table)}.${column}`));
}

export function columnDefinition(table: string, column: string) {
  return manifestEntry("column", `${qualify(table)}.${column}`)?.def as
    { type: string; notNull: boolean; default: string | null } | undefined;
}

/** Function by name (any signature) or by `name(arg types)`. */
export function hasFunction(name: string): boolean {
  return Boolean(manifestEntry("function", name));
}

export function functionDefinition(name: string): string | undefined {
  return manifestEntry("function", name)?.def.def as string | undefined;
}

export function hasTrigger(table: string, trigger: string): boolean {
  return Boolean(manifestEntry("trigger", `${qualify(table)}.${trigger}`));
}

export function triggerDefinition(table: string, trigger: string): string | undefined {
  return manifestEntry("trigger", `${qualify(table)}.${trigger}`)?.def.def as string | undefined;
}

export function hasIndex(index: string): boolean {
  return Boolean(manifestEntry("index", index));
}

export function indexDefinition(index: string): string | undefined {
  return manifestEntry("index", index)?.def.def as string | undefined;
}

export function hasPolicy(table: string, policy: string): boolean {
  return Boolean(manifestEntry("policy", `${qualify(table)}.${policy}`));
}

/** Constraints on a table, as pg_get_constraintdef text. */
export function tableConstraints(table: string): string[] {
  const prefix = `${qualify(table)}.`;
  return schemaManifest()
    .filter((entry) => entry.kind === "constraint" && entry.identity.startsWith(prefix))
    .map((entry) => String(entry.def.def));
}

export function tableRowLevelSecurity(table: string): { rls: boolean; forceRls: boolean } | undefined {
  const def = manifestEntry("table", table)?.def as { rls: boolean; forceRls: boolean } | undefined;
  return def ? { rls: def.rls, forceRls: def.forceRls } : undefined;
}
