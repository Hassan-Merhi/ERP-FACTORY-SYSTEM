#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...valueParts] = argument.split("=");
    return [key, valueParts.join("=")];
  }),
);

const manifestPath = args.get("--manifest");
const outputPath = args.get("--output");
if (!manifestPath || !outputPath) {
  console.error("Usage: node scripts/materialize-program6d-review.mjs --manifest=<review.json> --output=<classifications.json>");
  process.exit(2);
}

const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
if (manifest?.program !== "6D" || !manifest.groups || typeof manifest.groups !== "object") {
  throw new Error("Phase 10 review manifest must declare program 6D and classification groups.");
}

const templates = {
  "intentional-full-read": (id) => ({
    id,
    status: "intentional-full-read",
    rationale:
      "Reviewed bounded exception: the outer loop is request, company, report, or migration scoped and the nested read remains key scoped.",
    maximumRows: 10000,
    boundingEvidence:
      "Outer collection is already request/company/migration scoped; nested query is a point or aggregate lookup, not a cross-tenant scan.",
  }),
  "transaction-order-dependency": (id) => ({
    id,
    status: "transaction-order-dependency",
    rationale:
      "This point read participates in a mutation, repair, posting, costing, or row-lock sequence whose order protects state correctness.",
    orderingDependency:
      "Bulk prefetch or reordering can observe stale state or change transaction locking, idempotency, inventory, or accounting behavior.",
  }),
  "false-positive": (id) => ({
    id,
    status: "false-positive",
    rationale:
      "Static review found metadata, synchronization, or mutation SQL rather than an independent repeated application-data load.",
    falsePositiveReason:
      "The scanner matched lock, metadata, or mutation SQL as a read-like N+1; batching would not remove a repeated data fetch.",
  }),
};

const classifications = [];
const seen = new Set();
for (const [status, ids] of Object.entries(manifest.groups)) {
  const materialize = templates[status];
  if (!materialize || !Array.isArray(ids)) throw new Error(`Unsupported or malformed Phase 10 review group: ${status}`);
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith("P6D-")) throw new Error(`Invalid Program 6D finding id: ${String(id)}`);
    if (seen.has(id)) throw new Error(`Duplicate Program 6D finding id: ${id}`);
    seen.add(id);
    classifications.push(materialize(id));
  }
}

const output = {
  program: "6D",
  baselineHead: manifest.baselineHead ?? null,
  reviewedAt: manifest.reviewedAt ?? null,
  classifications,
};
const resolvedOutput = resolve(outputPath);
await mkdir(dirname(resolvedOutput), { recursive: true });
await writeFile(resolvedOutput, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Materialized ${classifications.length} Phase 10 query classifications to ${resolvedOutput}`);
