#!/usr/bin/env node
/**
 * Phase 5 account-picker regression ratchet.
 *
 * Compare the full account-selection markup on this branch with the PR's
 * merge base. It detects newly introduced non-searchable posting selectors,
 * exposed account codes/types in account options, and name labels derived
 * from codes/types inside UnifiedAccountPicker.
 *
 * This is a *ratchet*: existing debt in untouched/legacy administration
 * modules is not reclassified as a new failure; no allowlist of entire
 * directories silently exempts future regressions. The script compares the
 * number of offending constructs per file and rule with the base revision.
 * It runs in the UI Quality PR workflow, where checkout fetch-depth is 0.
 *
 * node scripts/audit-account-selector-new-code.mjs --base <PR_BASE_SHA>
 * node --test tests/account-selector-audit.node.test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")}: ${error.stderr?.toString().trim() ?? error.message}`);
  }
}

function allBlockBodies(source, openTag, closeTag) {
  const blocks = [];
  // Only the three audited JSX tags are accepted. Use literal patterns so
  // repository source cannot ever be interpolated into a dynamic regexp.
  const starts = {
    Select: /<Select(?=[\\s>])/g,
    select: /<select(?=[\\s>])/g,
    CommandItem: /<CommandItem(?=[\\s>])/g,
  };
  if (openTag !== closeTag || !Object.hasOwn(starts, openTag)) {
    throw new TypeError("Unsupported account selector tag");
  }
  const start = starts[openTag];
  for (const match of source.matchAll(start)) {
    const end = source.indexOf(`</${closeTag}>`, match.index);
    if (end < 0) continue;
    blocks.push(source.slice(match.index, end + closeTag.length + 3));
  }
  return blocks;
}

// Explicit account-option collections. A generic 'accounts' list can also be
// a list of customers, products, roles, or chart-of-accounts administration.
const ACCOUNT_COLLECTION = /\b(?:ledgerAccounts|cashAccounts|bankAccounts|postingAccounts|paymentAccounts|parentFreightAccounts|freightAccounts|cashLedgerAccounts|supplierAccounts|accountOptions|eligibleAccounts|accounts\?\.ledgers|accounts\.ledgers|accounts\?\.banks|accounts\.banks)\s*\??\.\s*(?:map|filter)\s*\(/i;
const ACCOUNT_MAP = /(?:\b(?:accounts|ledgers|banks)\s*\??\.\s*map\s*\(\s*\(?\s*(?:account|acct|acc)\b|ACCOUNT_OPTIONS)/i;
const NAMED_ACCOUNT = /\b(?:account|acct|acc|ledger|bankAccount|cashAccount|a)\.(?:name|accountName|code|accountType|subType)\b/;
const VISIBLE_CODE_OR_TYPE = /\b(?:account|acct|acc|ledger|bankAccount|cashAccount|a)\.(?:code|accountType|subType)\b|\baccount\.(?:type|category)\b/;

/** Pure source scanner. Returned issue counts are compared to the base. */
export function scanAccountSelectorSource(source) {
  const counts = {
    "unsearchable-account-select": 0,
    "visible-account-metadata": 0,
    "picker-name-uses-metadata": 0,
  };

  for (const tag of ["Select", "select"]) {
    for (const block of allBlockBodies(source, tag, tag)) {
      if (!/<(?:SelectItem|option)(?=[\s>])/.test(block)) continue;
      const isAccount = ACCOUNT_COLLECTION.test(block) || (ACCOUNT_MAP.test(block) && NAMED_ACCOUNT.test(block));
      if (!isAccount) continue;
      counts["unsearchable-account-select"] += 1;
      // Only inspect the rendered row labels, not form IDs or posting values.
      for (const row of [...block.matchAll(/<(?:SelectItem|option)(?=[\s>])[\s\S]*?<\/(?:SelectItem|option)>/g)]) {
        if (VISIBLE_CODE_OR_TYPE.test(row[0])) counts["visible-account-metadata"] += 1;
      }
    }
  }

  // Searchable CommandItem rows must also display/search by name alone.
  for (const row of allBlockBodies(source, "CommandItem", "CommandItem")) {
    if (NAMED_ACCOUNT.test(row) && VISIBLE_CODE_OR_TYPE.test(row)) {
      counts["visible-account-metadata"] += 1;
    }
  }

  // Passing an ID/code into the opaque 'value' is fine. Using it in the
  // displayed 'name' is not. Limit the check to named options expressions.
  for (const match of source.matchAll(/<UnifiedAccountPicker(?=[\s>])[\s\S]*?\/>/g)) {
    const block = match[0];
    if (/\bname\s*:\s*(?:`[^`]*\.(?:code|accountType|subType)\b|[^\n,}]{0,140}\.(?:code|accountType|subType)\b)/.test(block)) {
      counts["picker-name-uses-metadata"] += 1;
    }
  }
  return counts;
}

export function detectNewAccountSelectorIssues({ base, head = "HEAD", root = ROOT } = {}) {
  if (!base) throw new Error("An explicit --base commit is required for the Phase 5 ratchet.");
  const diff = git(["diff", "--name-only", "--diff-filter=ACMR", base, head, "--", "client/src"])
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file));
  const violations = [];
  for (const file of diff) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    const current = scanAccountSelectorSource(fs.readFileSync(fullPath, "utf8"));
    const originalSource = git(["show", `${base}:${file}`], { allowFailure: true });
    const original = scanAccountSelectorSource(originalSource);
    for (const [rule, count] of Object.entries(current)) {
      const previous = original[rule] ?? 0;
      if (count > previous) violations.push({ file, rule, current: count, base: previous });
    }
  }
  return { files: diff.length, violations };
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) {
  const index = process.argv.indexOf("--base");
  const base = index >= 0 ? process.argv[index + 1] : undefined;
  if (!base) {
    console.error("Usage: node scripts/audit-account-selector-new-code.mjs --base <PR_BASE_SHA>");
    process.exitCode = 2;
  } else {
    try {
      const { files, violations } = detectNewAccountSelectorIssues({ base });
      console.log(`Phase 5 account-selector audit: inspected ${files} changed client files.`);
      if (violations.length) {
        for (const issue of violations) {
          console.error(`- ${issue.file}: ${issue.rule} increased from ${issue.base} to ${issue.current}`);
        }
        console.error("Replace the new posting selector with UnifiedAccountPicker and show/search account names only.");
        process.exitCode = 1;
      } else {
        console.log("No newly introduced unsearchable posting selectors or exposed account codes/types.");
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
