import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFactoryWorkerIds } from "../server/lib/factoryWorkerCategoryMembership";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("factory worker category membership", () => {
  it("normalizes category worker ids safely", () => {
    expect(normalizeFactoryWorkerIds([3, "3", 2, 0, -1, "bad", null, 2])).toEqual([3, 2]);
    expect(normalizeFactoryWorkerIds(null)).toEqual([]);
  });

  it("removes category membership from every factory worker deactivation flow", () => {
    const crud = read("server/routes/factory-workers/crud.ts");
    const settlement = read("server/routes/factory-workers/bales-settle.ts");

    expect((crud.match(/await removeFactoryWorkerFromCategories\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((settlement.match(/await removeFactoryWorkerFromCategories\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("sanitizes category reads and writes to active workers only", () => {
    const routes = read("server/routes/factory/employee-pos/pos-financial/worker-categories.ts");

    expect(routes).toContain("pruneInactiveFactoryWorkerCategoryMembers(db, companyId)");
    expect((routes.match(/filterActiveFactoryWorkerIds\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("lets a stale inactive assignment be manually unchecked without allowing a new inactive assignment", () => {
    const dialog = read("client/src/pages/factory/factoryworkers/FactoryWorkersDialogs.tsx");
    const stockEntryGroups = read("client/src/pages/factory/bale-stock-entry/WorkerCategoriesTab.tsx");

    expect(dialog).toContain("disabled={!w.active && !catWorkerIds.includes(w.id)}");
    expect(dialog).toContain("if (w.active || catWorkerIds.includes(w.id)) toggleCatWorker(w.id)");
    expect(stockEntryGroups).toContain(".filter((w) => w.active !== false || catWorkerIds.includes(w.id))");
    expect(stockEntryGroups).toContain("if (!inactive || selected) toggleCatWorker(w.id)");
  });
});
