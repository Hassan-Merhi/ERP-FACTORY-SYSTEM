/**
 * Company-scoped ledger account display layout (GET/PUT) over HTTP, one rolled-back transaction per test.
 * Pinned: legacy account groups are synthesised only when no layout row
 * exists, every malformed layout is refused before any write, Admin only,
 * and accounts from another company are refused without touching the
 * stored layout.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PATH = "/api/accounts/display-layout";
const FACTORY_PATH = "/api/factory/account-display-layout";

async function ledger(w: FactoryWorld, code: string, extra: { parentId?: number; subType?: string } = {}) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active, parent_id, sub_type)
     VALUES ($1, $2::varchar, $2::text, 'Expense', '0', TRUE, $3, $4) RETURNING id`,
    [w.companyId, `${w.tag}${code}`, extra.parentId ?? null, extra.subType ?? null]
  );
}

const stored = (w: FactoryWorld) =>
  w.q(`SELECT node_key FROM account_display_layout WHERE company_id = $1 ORDER BY node_key`, [w.companyId]);

describe("account display layout GET", () => {
  it("synthesises legacy groups and ungrouped ledgers, preferring stored rows", async () => {
    await withFactoryWorld(async (w) => {
      const group = await ledger(w, "GRP", { subType: "Group" });
      const parent = await ledger(w, "PARENT");
      const child = await ledger(w, "CHILD", { parentId: parent });
      const loose = await ledger(w, "LOOSE");
      await w.q(
        `INSERT INTO account_display_layout (company_id, node_key, node_type, name, parent_key, sort_order)
         VALUES ($1, $2, 'group', 'Renamed', NULL, 1), ($1, $3, 'ledger', NULL, NULL, 2)`,
        [w.companyId, `group:legacy-${group}`, `ledger:${loose}`]
      );
      const res = await w.agent.get(PATH);
      expect(res.status).toBe(200);
      const byKey = new Map(res.body.nodes.map((n: { key: string }) => [n.key, n]));
      expect(byKey.get(`group:legacy-${group}`)).toMatchObject({ name: "Renamed", order: 1 });
      expect(byKey.get(`group:legacy-${parent}`)).toMatchObject({ type: "group", name: `${w.tag}PARENT` });
      expect(byKey.get(`ledger:${child}`)).toMatchObject({ parentKey: `group:legacy-${parent}` });
      expect(byKey.get(`ledger:${loose}`)).toMatchObject({ order: 2, parentKey: null });
    });
  });
});

describe("account display layout PUT", () => {
  const group = { key: "group:abcdefgh", type: "group", name: " Costs ", parentKey: null, order: 0 };

  it("refuses every malformed layout with 400 and writes nothing", async () => {
    await withFactoryWorld(async (w) => {
      const id = await ledger(w, "A");
      const bad: unknown[] = [
        "nope",
        Array.from({ length: 3001 }, () => ({})),
        [null],
        [{ ...group }, { ...group }],
        [{ ...group, type: "folder" }],
        [{ ...group, order: -1 }],
        [{ ...group, key: "group:x" }],
        [{ ...group, name: "  " }],
        [{ ...group, parentKey: "group:abcdefgh" }],
        [{ key: `ledger:${id}`, type: "ledger", name: "named", order: 1 }],
        [{ key: `ledger:${id}`, type: "ledger", parentKey: 5, order: 1 }],
        [{ key: `ledger:${id}`, type: "ledger", parentKey: "group:missing1", order: 1 }],
      ];
      for (const nodes of bad) {
        const res = await w.agent.put(PATH).send({ nodes });
        expect(res.status).toBe(400);
      }
      expect(await stored(w)).toEqual([]);
    });
  });

  it("refuses accounts from another company and keeps the previous layout", async () => {
    await withFactoryWorld(async (w) => {
      const id = await ledger(w, "A");
      const first = await w.agent
        .put(PATH)
        .send({ nodes: [group, { key: `ledger:${id}`, type: "ledger", parentKey: group.key, order: 1 }] });
      expect(first.status).toBe(200);
      expect(first.body.nodes[0].name).toBe("Costs");
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2::varchar, $2::text, 'Expense', '0', TRUE) RETURNING id`,
        [other, `${w.tag}F`]
      );
      const res = await w.agent.put(PATH).send({ nodes: [{ key: `ledger:${foreign}`, type: "ledger", order: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/outside this company/);
      expect((await stored(w)).map((r) => r.node_key)).toEqual(["group:abcdefgh", `ledger:${id}`]);

      const cleared = await w.agent.put(PATH).send({ nodes: [] });
      expect(cleared.status).toBe(200);
      expect(await stored(w)).toEqual([]);
    });
  });

  // Known gap (pinned): the factory alias is registered and used by the client
  // in factory mode, but the factory backend access boundary has no page rule
  // for it, so it is refused for every signed-in user, Admin included.
  it("refuses the factory alias at the factory access boundary for an Admin", async () => {
    await withFactoryWorld(async (w) => {
      const read = await w.agent.get(FACTORY_PATH);
      expect(read.status).toBe(403);
      expect(read.body.code).toBe("FACTORY_PAGE_ACCESS_DENIED");
      const write = await w.agent.put(FACTORY_PATH).send({ nodes: [group] });
      expect(write.status).toBe(403);
      expect(await stored(w)).toEqual([]);
    });
  });

  it("is Admin only", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.put(PATH).send({ nodes: [group] })).status).toBe(403);
      expect(await stored(w)).toEqual([]);
    });
  });
});
