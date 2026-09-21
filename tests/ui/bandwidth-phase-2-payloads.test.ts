import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Bandwidth Phase 2 payload contracts", () => {
  it("returns compact proforma summaries and preserves a detail route", () => {
    const source = read("server/routes/factory/customer-proformas/proformas.ts");
    const summaryStart = source.indexOf('if (profile === "summary")');
    const fullStart = source.indexOf("const rawProformasRes", summaryStart);
    const summary = source.slice(summaryStart, fullStart);

    expect(summary).toContain("COUNT(cpl.id)::int AS line_count");
    expect(summary).toContain("AS total_qty");
    expect(summary).toContain("AS total_weight_kg");
    expect(summary).toContain("AS total_amount");
    expect(summary).not.toContain("rawLines");
    expect(summary).toContain("lines: []");
    expect(source).toContain('app.get("/api/factory/customer-proformas/:id"');
  });

  it("paginates customer orders, workers, daily scans and shipping rows in the database", () => {
    const orders = read("server/routes/factory/customer-orders/orderCrudRoutes.ts");
    const workers = read("server/routes/factory-workers/lists.ts");
    const scans = read("server/routes/factory/factoryDailyScanRoutes.ts");
    const shipping = read("server/routes/factory/shipping-containers/rows.ts");
    expect(orders).toContain("ordersQuery.limit(pagination.pageSize).offset(pagination.offset)");
    expect(workers).toContain('req.query.profile === "summary"');
    expect(workers).not.toContain("photoUrl: factoryWorkers.photoUrl");
    expect(scans).toMatch(/parseListPagination[\s\S]*pagination\.pageSize, pagination\.offset/);
    expect(shipping).toContain("LIMIT $${limitParam} OFFSET $${offsetParam}");
  });

  it("uses cursor deltas for Daily Scan while retaining periodic full reconciliation", () => {
    const server = read("server/routes/factory/factoryDailyScanRoutes.ts");
    const client = read("client/src/lib/phase4BandwidthFetch.ts");
    const main = read("client/src/main.tsx");

    expect((server.match(/readAfterId\(req\.query\.afterId\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(client).toContain("fetchAllPages(originalFetch, url, init, maxId || undefined)");
    expect(client).toContain("const DAILY_RECONCILE_MS = 10 * 60_000");
    expect(main).toContain('import "./lib/phase4BandwidthFetch"');
  });

  it("keeps audit list changes compact and loads full changes on demand", () => {
    const server = read("server/routes/auth/auditLogRoutes.ts");
    const client = read("client/src/pages/settings/AuditLog.tsx");
    expect(server).toContain("query.detailId");
    expect(server).toContain("changeSummary: summarizeChanges(changes)");
    expect(client).toContain('profile: "summary"');
    expect(client).toContain("/api/audit-log?detailId=${selectedLogId}");
  });

  it("uses compact workers by default while worker management opts into full records", () => {
    const server = read("server/routes/factory-workers/lists.ts");
    const management = read("client/src/pages/factory/factoryworkers/useFactoryWorkersModel.tsx");
    expect(server).toContain('req.query.profile !== "full"');
    expect(server).toContain("pendingAdvanceBalance");
    expect(management).toContain("/api/factory/workers?profile=full");
  });

  it("loads active proforma details only after the summary identifies the active record", () => {
    for (const file of [
      "client/src/pages/CustomerInvoiceCreate.tsx",
      "client/src/pages/factory/FactoryInvoiceCreate.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("profile=summary");
      expect(source).toContain("activeProformaSummary?.id");
      expect(source).toContain("/api/factory/customer-proformas/${activeProformaSummary?.id}");
    }
  });

  it("keeps loading screens on compact summaries without eager detail fetches", () => {
    const client = read("client/src/lib/phase4BandwidthFetch.ts");

    expect(client).toContain("handleProformaSummary");
    expect(client).not.toContain("getProformaDetail(");
  });

  it("retains existing compact Bale Ledger and container detail profiles", () => {
    const ledger = read("server/routes/factory/employee-pos/employeeLedgerWasteRoutes.ts");
    const bridge = read("server/apiPaginationBridge.mjs");
    expect(ledger).toContain("Strip baleDetails from the summary response");
    expect(ledger).toContain("/api/factory/bale-ledger/details");
    expect(bridge).toContain('profile === "otw-summary"');
    expect(bridge).toContain('profile === "combined-detail"');
  });
});
