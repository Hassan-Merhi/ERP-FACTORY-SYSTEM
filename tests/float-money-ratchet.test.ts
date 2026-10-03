/**
 * parseFloat may not spread: config/float-money-baseline.json records how many
 * parseFloat( calls each server/shared source file has, and the counts can
 * only fall. Money is summed with server/lib/money.ts instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const baseline = JSON.parse(fs.readFileSync(path.join(root, "config/float-money-baseline.json"), "utf8")) as {
  total: number;
  files: Record<string, number>;
};

function currentCounts(): Record<string, number> {
  // CI checks the repository out as a tarball without .git, so walk the tree
  // instead of asking git for the file list.
  const tracked = ["server", "shared"]
    .flatMap((dir) =>
      (fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]).map((file) =>
        path.posix.join(dir, file.split(path.sep).join("/"))
      )
    )
    .filter((file) => /\.(ts|tsx|mjs)$/.test(file) && !file.includes(".test."));
  const counts: Record<string, number> = {};
  for (const file of tracked) {
    const matches = fs.readFileSync(path.join(root, file), "utf8").match(/\bparseFloat\(/g);
    if (matches?.length) counts[file] = matches.length;
  }
  return counts;
}

describe("float money ratchet", () => {
  const counts = currentCounts();

  it("adds no parseFloat call to any file", () => {
    const grown = Object.entries(counts)
      .filter(([file, count]) => count > (baseline.files[file] ?? 0))
      .map(([file, count]) => `${file}: ${baseline.files[file] ?? 0} -> ${count}`);
    expect(grown, "Use toMoney/sumMoney from server/lib/money.ts instead of parseFloat").toEqual([]);
  });

  it("keeps the baseline as low as the code (lower it when calls are removed)", () => {
    const stale = Object.entries(baseline.files)
      .filter(([file, count]) => (counts[file] ?? 0) < count)
      .map(([file, count]) => `${file}: ${count} -> ${counts[file] ?? 0}`);
    expect(stale, "Lower these entries in config/float-money-baseline.json").toEqual([]);
    expect(baseline.total).toBe(Object.values(baseline.files).reduce((sum, count) => sum + count, 0));
  });
});
