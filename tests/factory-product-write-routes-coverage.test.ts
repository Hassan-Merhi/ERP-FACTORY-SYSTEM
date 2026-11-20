/**
 * POST/PATCH /api/factory/bale-products (productWriteRoutes) through the real
 * app inside one rolled-back transaction: the admin-authorization refusals
 * for non-admin callers, article-code generation per grade (skipping taken
 * article codes and codes) after the highest existing number, regeneration
 * of a taken graded code, refusal of a taken custom code or name, optional
 * fields, database failures mapped to plain messages, and company-scoped
 * edits limited to the editable fields.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/bale-products";
const PASSWORD = "rolledback-pass-123";

const productCount = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM factory_bale_products WHERE company_id = $1`, [w.companyId]))[0].n;

async function product(w: FactoryWorld, code: string, articleCode: string | null, name: string) {
  return w.one(
    `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.companyId, code, articleCode, name]
  );
}

describe("factory bale product create", () => {
  it("needs valid admin authorization from a non-admin caller", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      const other = await w.agentFor("Manager");
      const [peer] = await w.q<{ username: string }>(
        `SELECT u.username FROM users u JOIN user_company_roles r ON r.user_id = u.id
          WHERE r.company_id = $1 AND r.role = 'Manager' ORDER BY u.username LIMIT 1`,
        [w.companyId]
      );
      void other;
      const outsider = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const [foreignAdmin] = await w.q<{ username: string }>(
        `INSERT INTO users (username, password) SELECT $1, password FROM users WHERE username = $2 RETURNING username`,
        [`${w.tag.toLowerCase()}_foreign`, w.username]
      );
      await w.q(
        `INSERT INTO user_company_roles (user_id, company_id, role) SELECT id, $1, 'Admin' FROM users WHERE username = $2`,
        [outsider, foreignAdmin.username]
      );
      const before = await productCount(w);
      const attempts: Array<[unknown, string]> = [
        [undefined, "Admin authorization required to create products"],
        [{ username: w.username }, "Admin authorization required to create products"],
        [{ username: "no-such-user-xyz", password: "x" }, "Invalid admin credentials"],
        [{ username: w.username, password: "wrong" }, "Invalid admin credentials"],
        [
          { username: peer.username, password: PASSWORD },
          "The provided user does not have admin access to this company",
        ],
        [
          { username: foreignAdmin.username, password: PASSWORD },
          "The provided user does not have admin access to this company",
        ],
      ];
      for (const [adminAuth, message] of attempts) {
        const res = await manager.post(BASE).send({ name: "Blocked", grade: "#1", adminAuth });
        expect(res.status, JSON.stringify(adminAuth)).toBe(403);
        expect(res.body.message).toBe(message);
      }
      expect(await productCount(w)).toBe(before);

      const ok = await manager
        .post(BASE)
        .send({ name: "Approved", grade: "#1", adminAuth: { username: w.username, password: PASSWORD } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.articleCode).toBe("HMD11001");
    }));

  it("generates graded and ungraded article codes past taken ones", () =>
    withFactoryWorld(async (w) => {
      await product(w, "X1", "HMD12001", "Taken article");
      await product(w, "HMD12002", "OTHER-2", "Taken code");
      const graded = await w.agent.post(BASE).send({ name: "Grade two", grade: "#2" });
      expect(graded.status, JSON.stringify(graded.body)).toBe(200);
      expect(graded.body).toMatchObject({ articleCode: "HMD12003", code: "HMD12003", active: true });

      await product(w, "Y1", "HMD00001", "Old ungraded");
      await product(w, "Y2", "HMD00002", "Old ungraded 2");
      await w.q(`UPDATE factory_bale_products SET article_code = 'HMD00003' WHERE code = 'Y2'`);
      const ungraded = await w.agent.post(BASE).send({ name: "No grade", grade: "unknown" });
      // After the highest number (003); the gap at 002 is not reused.
      expect(ungraded.body.articleCode).toBe("HMD00004");
    }));

  it("numbers a new graded code after this company's highest, ignoring gaps and other companies", () =>
    withFactoryWorld(async (w) => {
      await product(w, "G1", "HMD14001", "Grade four one");
      await product(w, "G7", "HMD14007", "Grade four seven");
      await product(w, "GX", "HMD14ABC", "Not numeric");
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}N`,
      ]);
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, article_code, name) VALUES ($1, 'HMD14050', 'HMD14050', 'Theirs')`,
        [other]
      );
      const first = await w.agent.post(BASE).send({ name: "Grade four new", grade: "#4" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ articleCode: "HMD14008", code: "HMD14008" });
      const second = await w.agent.post(BASE).send({ name: "Grade four newer", grade: "#4" });
      expect(second.body.articleCode).toBe("HMD14009");
      const codes = await w.q(`SELECT article_code FROM factory_bale_products WHERE company_id = $1 ORDER BY 1`, [
        w.companyId,
      ]);
      expect(new Set(codes.map((r) => r.article_code)).size).toBe(codes.length);
    }));

  it("keeps a free custom code, regenerates a taken graded one and refuses a taken custom one", () =>
    withFactoryWorld(async (w) => {
      const custom = await w.agent.post(BASE).send({
        name: "Custom",
        articleCode: "ab-12 x",
        description: "desc",
        weightPerBaleKg: 45,
        sellingPrice: "1.20",
        productionPrice: "0.80",
        labelDesignColor: "#ff0000",
        active: false,
      });
      expect(custom.status, JSON.stringify(custom.body)).toBe(200);
      expect(custom.body).toMatchObject({
        code: "AB12X",
        articleCode: "ab-12 x",
        description: "desc",
        weightPerBaleKg: "45",
        labelDesignColor: "#ff0000",
        active: false,
      });

      await product(w, "HMD13001", "HMD13001", "Grade three");
      const regenerated = await w.agent.post(BASE).send({ name: "Grade three again", articleCode: "HMD13001" });
      expect(regenerated.body.articleCode).toBe("HMD13002");

      const before = await productCount(w);
      const taken = await w.agent.post(BASE).send({ name: "Clash", articleCode: "ab-12 x" });
      expect(taken.status).toBe(400);
      expect(taken.body.message).toBe("A product with this article code already exists");
      const dupName = await w.agent.post(BASE).send({ name: "  custom ", grade: "#4" });
      expect(dupName.status).toBe(400);
      expect(dupName.body.message).toBe('A product named "custom" already exists');
      expect(await productCount(w)).toBe(before);

      await w.q(`SAVEPOINT bad_insert`);
      const badCategory = await w.agent
        .post(BASE)
        .send({ name: "Bad cat", articleCode: "ZZ9", categoryId: 2147483000 });
      expect(badCategory.status).toBe(400);
      // A plain message: no SQL text or parameters reach the caller.
      expect(badCategory.body).toEqual({
        message: "The selected category does not exist",
        code: "PRODUCT_REFERENCE_MISSING",
      });
      await w.q(`ROLLBACK TO SAVEPOINT bad_insert`);

      const notText = await w.agent.post(BASE).send({ name: "Numeric code", articleCode: 42 });
      expect(notText.status).toBe(400);
      expect(notText.body.code).toBe("PRODUCT_INVALID");
      expect(await productCount(w)).toBe(before);
    }));
});

describe("factory bale product edit", () => {
  it("edits only this company's products", () =>
    withFactoryWorld(async (w) => {
      const id = await product(w, `${w.tag}P`, null, "Editable");
      expect((await w.agent.patch(`${BASE}/abc`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${BASE}/2147483000`).send({ name: "x" })).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Q`,
      ]);
      const theirs = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2, 'Theirs') RETURNING id`,
        [other, `${w.tag}T`]
      );
      expect((await w.agent.patch(`${BASE}/${theirs}`).send({ name: "Mine now" })).status).toBe(404);
      const [row] = await w.q(`SELECT name FROM factory_bale_products WHERE id = $1`, [theirs]);
      expect(row.name).toBe("Theirs");

      const ok = await w.agent.patch(`${BASE}/${id}`).send({ name: "Edited", sellingPrice: "2.50" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: "Edited", sellingPrice: "2.50" });

      // The access boundary refuses a body that names another company.
      const moved = await w.agent.patch(`${BASE}/${id}`).send({ companyId: other });
      expect(moved.status).toBe(403);
      const state = () =>
        w.q(`SELECT company_id, name, deleted_at, created_at FROM factory_bale_products WHERE id = $1`, [id]);
      const before = await state();
      expect(Number(before[0].company_id)).toBe(w.companyId);

      // Only the editable fields are accepted; ids, ownership and timestamps are refused.
      const forbidden = await w.agent
        .patch(`${BASE}/${id}`)
        .send({ name: "Sneaky", id: 1, deletedAt: "2026-01-01T00:00:00Z", createdAt: "2020-01-01T00:00:00Z" });
      expect(forbidden.status).toBe(400);
      expect(forbidden.body).toEqual({
        message: "These product fields cannot be edited: id, deletedAt, createdAt",
        code: "PRODUCT_FIELD_NOT_EDITABLE",
      });
      expect(await state()).toEqual(before);
    }));

  it("maps edit failures to plain messages without SQL text", () =>
    withFactoryWorld(async (w) => {
      const id = await product(w, `${w.tag}A`, `${w.tag}-A`, "First");
      await product(w, `${w.tag}B`, `${w.tag}-B`, "Second");

      await w.q(`SAVEPOINT dup_code`);
      const dup = await w.agent.patch(`${BASE}/${id}`).send({ code: `${w.tag}B` });
      expect(dup.status).toBe(409);
      expect(dup.body).toEqual({
        message: "A product with this code or article code already exists",
        code: "PRODUCT_CODE_TAKEN",
      });
      await w.q(`ROLLBACK TO SAVEPOINT dup_code`);

      await w.q(`SAVEPOINT bad_price`);
      const bad = await w.agent.patch(`${BASE}/${id}`).send({ sellingPrice: "abc" });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ message: "One or more product fields are invalid", code: "PRODUCT_INVALID" });
      expect(JSON.stringify(bad.body)).not.toMatch(/Failed query|factory_bale_products/);
      await w.q(`ROLLBACK TO SAVEPOINT bad_price`);

      const [row] = await w.q(`SELECT code, selling_price::text AS price FROM factory_bale_products WHERE id = $1`, [
        id,
      ]);
      expect(row).toEqual({ code: `${w.tag}A`, price: "0.00" });
    }));
});
