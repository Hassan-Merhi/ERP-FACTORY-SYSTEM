import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const resolve = (file: string) => path.join(root, file);
const read = (file: string) => fs.readFileSync(resolve(file), "utf8");
const quotedValues = (source: string) => [...source.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);

function ownedQueryTypes(): string[] {
  return fs
    .readdirSync(resolve("server/chat/reports/domains"))
    .filter((name) => name.endsWith("ReportDomain.ts") && name !== "createReportDomainHandler.ts")
    .flatMap((name) => {
      const source = read(path.join("server/chat/reports/domains", name));
      const owned = source.match(/createReportDomainHandler\("[^"]+",\s*\[([\s\S]*?)\]\);/);
      return owned ? quotedValues(owned[1]) : [];
    });
}

function implementedQueryTypes(): string[] {
  return fs
    .readdirSync(resolve("server/chat/reports/implementations"))
    .filter((name) => /^phase\d+ReportShard\.ts$/.test(name))
    .flatMap((name) => [
      ...read(path.join("server/chat/reports/implementations", name)).matchAll(/case\s+"([a-z0-9_]+)"\s*:/g),
    ])
    .map((match) => match[1]);
}

describe("Phase 6 chat reporting architecture", () => {
  it("keeps chatService behind the stable report gateway", () => {
    // The invariant is that the chat path reaches reporting only through the
    // reports gateway and never branches on queryType itself. #1422 moved the
    // Phase 1 data query out of chatService into chat/phase1DataQuery, so the
    // direct gateway import now lives one delegation deeper — the boundary is
    // unchanged, the file holding the import is not. Both files are checked for
    // the switch so the added indirection cannot become a place to hide one.
    const source = read("server/chatService.ts");
    expect(source).toContain('from "./chat/phase1DataQuery"');
    expect(source).not.toContain("switch (params.queryType)");

    const dataQuery = read("server/chat/phase1DataQuery.ts");
    expect(dataQuery).toContain('from "./reports"');
    expect(dataQuery).not.toContain("switch (params.queryType)");
  });

  it("keeps the public report module as a thin dispatcher facade", () => {
    const source = read("server/chat/reports.ts");
    expect(source).toContain("dispatchDataQuery");
    expect(source.split(/\r?\n/).length).toBeLessThanOrEqual(30);
  });

  it("registers seven focused domains without a compatibility fallback", () => {
    const source = read("server/chat/reports/domains/reportDomainDispatcher.ts");
    expect(source).toContain("accountingReportDomain");
    expect(source).toContain("customerSupplierReportDomain");
    expect(source).toContain("inventoryReportDomain");
    expect(source).toContain("factoryReportDomain");
    expect(source).toContain("containerReportDomain");
    expect(source).toContain("salesReportDomain");
    expect(source).toContain("operationsReportDomain");
    expect(source).not.toMatch(/runLegacyDataQuery|legacyReportEngine/);
    expect(fs.existsSync(resolve("server/chat/reports/legacyReportEngine.ts"))).toBe(false);
  });

  it("gives all 71 report types exactly one owner and implementation", () => {
    const owned = ownedQueryTypes();
    const implemented = implementedQueryTypes();
    expect(owned).toHaveLength(71);
    expect(new Set(owned).size).toBe(71);
    expect(implemented).toHaveLength(71);
    expect(new Set(implemented).size).toBe(71);
    expect([...owned].sort()).toEqual([...implemented].sort());
  });

  it("keeps each implementation shard below the architecture threshold", () => {
    const shardFiles = fs
      .readdirSync(resolve("server/chat/reports/implementations"))
      .filter((name) => /^phase\d+ReportShard\.ts$/.test(name));
    expect(shardFiles).toHaveLength(7);
    for (const file of shardFiles) {
      expect(read(path.join("server/chat/reports/implementations", file)).split(/\r?\n/).length).toBeLessThanOrEqual(
        900
      );
    }
  });
});
