/**
 * Factory MHD View (GET / PUT /api/factory/mhd-view) through the real app in
 * one rolled-back transaction: the empty view, malformed stored settings, the
 * Admin/Owner role gate, row validation, duplicate / unknown / ambiguous /
 * other-company article codes, optimistic revision conflicts and the five
 * snapshot history with its audit event.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/factory/mhd-view";

let seq = 0;
async function product(w: FactoryWorld, articleCode: string | null, name: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, `${w.tag}-P${++seq}`, name, articleCode]
  );
}

const save = (w: FactoryWorld, rows: unknown, expectedRevision: unknown) =>
  w.agent.put(URL).send({ rows, expectedRevision });

describe("Factory MHD View", () => {
  it("reads an empty view, ignores malformed stored rows and lists only coded products", () =>
    withFactoryWorld(async (w) => {
      await product(w, "ART-A", "Alpha");
      await product(w, null, "No code");
      const empty = await w.agent.get(URL);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ revision: 0, rows: [], history: [], updatedAt: "", canEdit: true });
      expect(empty.body.products).toEqual([expect.objectContaining({ articleCode: "ART-A", name: "Alpha" })]);

      await w.q(
        `INSERT INTO factory_settings (company_id, extra_settings) VALUES ($1, $2::jsonb)
           ON CONFLICT (company_id) DO UPDATE SET extra_settings = EXCLUDED.extra_settings`,
        [
          w.companyId,
          JSON.stringify({
            mhdView: {
              revision: "x",
              updatedAt: 5,
              rows: [{ articleCode: "ART-A", itemName: "A", sortOrder: 0 }, { articleCode: 1 }, null],
              history: [{ revision: 1, updatedAt: "t", rows: [] }, { revision: "bad" }],
            },
          }),
        ]
      );
      const messy = await w.agent.get(URL);
      expect(messy.body).toMatchObject({
        revision: 0,
        updatedAt: "",
        rows: [{ articleCode: "ART-A", itemName: "A", sortOrder: 0 }],
        history: [{ revision: 1, updatedAt: "t", rows: [] }],
      });
      await w.q(
        `UPDATE factory_settings SET extra_settings = '{"mhdView": {"rows": "nope"}}'::jsonb WHERE company_id = $1`,
        [w.companyId]
      );
      expect((await w.agent.get(URL)).body).toMatchObject({ rows: [], history: [] });

      const manager = await w.agentFor("Manager");
      expect((await manager.get(URL)).body.canEdit).toBe(false);
      expect((await manager.put(URL).send({ rows: [], expectedRevision: 0 })).status).toBe(403);
    }));

  it("refuses malformed bodies and rows, duplicates, unknown, ambiguous and other-company codes", () =>
    withFactoryWorld(async (w) => {
      await product(w, "ART-A", "Alpha");
      await product(w, "dup-1", "Dup lower");
      await product(w, " DUP-1", "Dup spaced");
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      await product(w, "ART-Z", "Foreign", other);

      expect((await save(w, "rows", 0)).body.message).toBe("Expected ordered rows and a valid revision");
      expect((await save(w, [], "1")).status).toBe(400);
      expect((await save(w, [{ articleCode: "  ", itemName: "" }], 0)).body.message).toMatch(
        /requires an article code/
      );
      expect((await save(w, [{ articleCode: "A", itemName: "x".repeat(251) }], 0)).status).toBe(400);
      expect((await save(w, ["ART-A"], 0)).status).toBe(400);
      const dup = await save(
        w,
        [
          { articleCode: "art-a", itemName: "a" },
          { articleCode: "ART-A ", itemName: "b" },
        ],
        0
      );
      expect(dup.body.message).toBe("Duplicate article code: ART-A");
      const unknown = await save(
        w,
        [
          { articleCode: "ART-A", itemName: "ok" },
          { articleCode: "ART-Z", itemName: "foreign" },
          { articleCode: "DUP-1", itemName: "ambiguous" },
        ],
        0
      );
      expect([unknown.status, unknown.body.articleCodes]).toEqual([400, ["ART-Z", "DUP-1"]]);
      const settings = await w.q(`SELECT 1 FROM factory_settings WHERE company_id = $1`, [w.companyId]);
      expect(settings).toHaveLength(0);
    }));

  it("saves revisions with history and audit, and refuses a stale revision", () =>
    withFactoryWorld(async (w) => {
      await product(w, "ART-A", "Alpha");
      await product(w, "ART-B", "Beta");
      const first = await save(
        w,
        [
          { articleCode: "art-b", itemName: " Beta alias " },
          { articleCode: "ART-A", itemName: "" },
        ],
        0
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        revision: 1,
        history: [],
        rows: [
          { articleCode: "ART-B", itemName: "Beta alias", sortOrder: 0 },
          { articleCode: "ART-A", itemName: "", sortOrder: 1 },
        ],
      });
      const stale = await save(w, [], 0);
      expect([stale.status, stale.body.message]).toEqual([
        409,
        "MHD View was updated by someone else. Reload and retry.",
      ]);
      let revision = 1;
      for (let i = 0; i < 6; i += 1) {
        const res = await save(w, [{ articleCode: "ART-A", itemName: `v${i}` }], revision);
        expect(res.status).toBe(200);
        revision = res.body.revision;
      }
      const view = await w.agent.get(URL);
      expect(view.body.revision).toBe(7);
      expect(view.body.history.map((h: { revision: number }) => h.revision)).toEqual([2, 3, 4, 5, 6]);
      const audits = await w.q(
        `SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND table_name = 'factory_settings' AND record_identifier = 'mhdView'`,
        [w.companyId]
      );
      expect(audits[0].n).toBe(7);
    }));
});
