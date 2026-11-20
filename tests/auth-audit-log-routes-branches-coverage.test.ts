/**
 * GET /api/audit-log: filters, pagination, summary profile, detail reads with
 * historical stock-transfer revision enrichment, and company isolation. One
 * rolled-back transaction per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function audit(
  w: FactoryWorld,
  row: {
    action?: string;
    tableName?: string;
    recordId?: number | null;
    identifier?: string;
    changes?: unknown;
    companyId?: number | null;
    createdAt?: string;
    userId?: string;
  }
) {
  return w.one(
    `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9::timestamp, now())) RETURNING id`,
    [
      row.userId ?? w.userId,
      w.username,
      row.companyId === undefined ? w.companyId : row.companyId,
      row.action ?? "update",
      row.tableName ?? `${w.tag.toLowerCase()}_things`,
      row.recordId ?? null,
      row.identifier ?? `${w.tag} record`,
      row.changes === undefined ? null : JSON.stringify(row.changes),
      row.createdAt ?? null,
    ]
  );
}

const list = (w: FactoryWorld, params: Record<string, string | number>) =>
  w.agent.get("/api/audit-log").query({ ...params });

describe("GET /api/audit-log list", () => {
  it("filters by module, user, action list, dates and search, and pages the results", async () => {
    await withFactoryWorld(async (w) => {
      const table = `${w.tag.toLowerCase()}_things`;
      await audit(w, { action: "create", identifier: `${w.tag} alpha`, createdAt: "2026-01-05 10:00:00" });
      await audit(w, { action: "Delete", identifier: `${w.tag} beta`, createdAt: "2026-01-06 10:00:00" });
      await audit(w, { action: "export", identifier: `${w.tag} gamma`, createdAt: "2026-01-07 10:00:00" });
      await audit(w, { action: "login", identifier: `${w.tag} hidden login` });
      await audit(w, { tableName: "security_events", identifier: `${w.tag} hidden security` });

      const all = await list(w, { module: table, limit: "abc", action: "all" });
      expect(all.status).toBe(200);
      expect(all.headers["cache-control"]).toBe("private, max-age=15");
      expect(all.body.total).toBe(3);
      expect(all.body.knownModules).toContain(table);
      expect(all.body.knownModules).not.toContain("security_events");

      const multi = await list(w, { tableName: table, action: "create, DELETE ,", userId: w.userId });
      expect(multi.body.logs.map((row: { recordIdentifier: string }) => row.recordIdentifier).sort()).toEqual([
        `${w.tag} alpha`,
        `${w.tag} beta`,
      ]);
      const single = await list(w, { tableName: table, action: "export" });
      expect(single.body.total).toBe(1);

      const ranged = await list(w, { tableName: table, from: "2026-01-06", to: "2026-01-06" });
      expect(ranged.body.logs.map((row: { recordIdentifier: string }) => row.recordIdentifier)).toEqual([
        `${w.tag} beta`,
      ]);
      const rangedAlias = await list(w, { tableName: table, dateFrom: "2026-01-07", dateTo: "2026-12-31" });
      expect(rangedAlias.body.total).toBe(1);

      const searched = await list(w, { search: `  ${w.tag} gamma ` });
      expect(searched.body.total).toBe(1);

      const paged = await list(w, { tableName: table, limit: 2, page: 2 });
      expect(paged.body).toMatchObject({ total: 3, totalPages: 2 });
      expect(paged.body.logs).toHaveLength(1);
      const offset = await list(w, { tableName: table, limit: 500, offset: "x" });
      expect(offset.body.logs).toHaveLength(3);
      const empty = await list(w, { tableName: `${table}_none`, page: "0" });
      expect(empty.body).toMatchObject({ total: 0, totalPages: 1, logs: [] });
    });
  });

  it("summarizes change fields in the summary profile", async () => {
    await withFactoryWorld(async (w) => {
      const table = `${w.tag.toLowerCase()}_things`;
      await audit(w, {
        identifier: "many",
        changes: { unitPrice: 1, stock_level: 2, name: 3, extraOne: 4, extraTwo: 5 },
      });
      await audit(w, { identifier: "few", changes: { stock_level: 1, qty: 2 } });
      await audit(w, { identifier: "empty", changes: {} });
      await audit(w, { identifier: "list", changes: [1, 2] });
      await audit(w, { identifier: "none" });
      const res = await list(w, { tableName: table, profile: "summary" });
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(
        res.body.logs.map((row: { recordIdentifier: string; changeSummary: string | null; changes?: unknown }) => [
          row.recordIdentifier,
          row,
        ])
      );
      // jsonb orders keys by length, then bytewise.
      expect(byId.many.changeSummary).toBe("Name, Extra One, Extra Two and 2 more");
      expect(byId.few.changeSummary).toBe("Qty, Stock Level");
      expect(byId.empty.changeSummary).toBeNull();
      expect(byId.list.changeSummary).toBeNull();
      expect(byId.none.changeSummary).toBeNull();
      expect("changes" in byId.many).toBe(false);
    });
  });

  it("never returns another company's rows or Developer activity", async () => {
    await withFactoryWorld(async (w) => {
      const table = `${w.tag.toLowerCase()}_things`;
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const foreign = await audit(w, { companyId: other, identifier: "foreign" });
      const [dev] = await w.q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
        `${w.tag.toLowerCase()}_dev`,
      ]);
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Developer')`, [
        dev.id,
        w.companyId,
      ]);
      await audit(w, { userId: dev.id, identifier: "developer" });
      const res = await list(w, { tableName: table });
      expect(res.body.total).toBe(0);
      expect((await list(w, { detailId: foreign })).status).toBe(404);
    });
  });

  it("refuses users whose role has the audit export disabled", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(
        `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled) VALUES ($1, 'Manager', 'exp_audit_log', false)
         ON CONFLICT DO NOTHING`,
        [w.companyId]
      );
      const manager = await w.agentFor("Manager");
      const res = await manager.get("/api/audit-log");
      expect(res.status).toBe(403);
    });
  });
});

describe("GET /api/audit-log detail", () => {
  it("validates the id and answers 404 for a missing row", async () => {
    await withFactoryWorld(async (w) => {
      const bad = await list(w, { detailId: "abc" });
      expect(bad.status).toBe(400);
      expect((await list(w, { detailId: 2147480000 })).status).toBe(404);
      const plain = await audit(w, { identifier: "plain", changes: { a: 1 } });
      const res = await list(w, { detailId: plain });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: plain, recordIdentifier: "plain", changes: { a: 1 } });
    });
  });

  it("enriches historical stock-transfer revision rows from immutable revision items only when needed", async () => {
    await withFactoryWorld(async (w) => {
      const itemId = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, 'pcs') RETURNING id`,
        [w.companyId, `${w.tag}SKU`]
      );
      const revisionId = 2000000000 + Math.floor(Math.random() * 100000000);
      await w.q(
        `INSERT INTO stock_transfer_revision_items
           (revision_id, stock_item_id, stock_item_name, source_location_id, source_location_name, original_quantity, new_quantity, delta)
         VALUES ($1, $2, 'Widget', $3, 'Yard', 5, 3, -2), ($1, $2, 'Widget', NULL, NULL, 1, 2, 1)`,
        [revisionId, itemId, w.locationId]
      );
      const old = await audit(w, {
        tableName: "stock_transfer_revisions",
        recordId: revisionId,
        changes: { status: { new: "approved" } },
      });
      const enriched = await list(w, { detailId: old });
      expect(enriched.status).toBe(200);
      expect(enriched.body.changes.status).toEqual({ new: "approved" });
      expect(enriched.body.changes.items.new).toEqual([
        expect.objectContaining({
          stockItemId: itemId,
          sourceLocationId: w.locationId,
          originalQuantity: 5,
          delta: -2,
        }),
        expect.objectContaining({ sourceLocationId: null, newQuantity: 2, delta: 1 }),
      ]);

      const already = await audit(w, {
        tableName: "stock_transfer_revisions",
        recordId: revisionId,
        changes: { items: { new: [{ stockItemId: 1 }] } },
      });
      expect((await list(w, { detailId: already })).body.changes.items.new).toEqual([{ stockItemId: 1 }]);

      const noItems = await audit(w, { tableName: "stock_transfer_revisions", recordId: revisionId + 1, changes: [1] });
      expect((await list(w, { detailId: noItems })).body.changes).toEqual([1]);
      const noRecord = await audit(w, { tableName: "stock_transfer_revisions", recordId: null });
      expect((await list(w, { detailId: noRecord })).body.changes).toBeNull();
    });
  });
});
