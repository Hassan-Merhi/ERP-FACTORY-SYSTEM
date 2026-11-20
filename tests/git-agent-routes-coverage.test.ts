/**
 * server/routes/git/gitAgentRoutes.ts over HTTP against PostgreSQL, one
 * rolled-back company per test.
 *
 * Pinned: notes and adjustments round-trip (blank note and empty-agent
 * fallbacks included); adjustment validation refuses a blank description, a
 * non-positive or non-numeric amount and an unknown type without writing;
 * deletes are scoped to company and agent; prepaid set-all drops non-numeric
 * ids; the replace flow refuses missing, identical, unknown, undesignated and
 * duty-mismatched containers and swaps only on confirmation. Every route that
 * takes a company id refuses another company's id, and set-all / replace
 * refuse another company's container.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const AGENT = "Agent Smith";
const enc = encodeURIComponent(AGENT);

async function container(w: FactoryWorld, number: string, dutyFee: string | null, companyId = w.companyId) {
  const supplier = await w.one(
    `INSERT INTO suppliers (company_id, code, email, legal_name) VALUES ($1, $2, '', 'Supplier') RETURNING id`,
    [companyId, `${w.tag}S${number}`]
  );
  return w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, duty_fee)
     VALUES ($1, $2, '2026-03-01', $3, $4) RETURNING id`,
    [companyId, `${w.tag}${number}`, supplier, dutyFee]
  );
}

const designations = (w: FactoryWorld) =>
  w.q(
    `SELECT container_id FROM git_prepaid_designations WHERE company_id = $1 AND agent_name = $2 ORDER BY container_id`,
    [w.companyId, AGENT]
  );

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}O`]);

describe("agent notes and adjustments", () => {
  it("round-trips notes with blank fallbacks", () =>
    withFactoryWorld(async (w) => {
      const c = w.companyId;
      expect((await w.agent.get(`/api/git/agent-note/${c}/${enc}`)).body).toEqual({ note: "" });
      const put = await w.agent.put(`/api/git/agent-note/${c}/${enc}`).send({ note: "  call Monday  " });
      expect(put.body).toEqual({ ok: true, note: "call Monday" });
      const blank = await w.agent.put(`/api/git/agent-note/${c}/Other`).send({});
      expect(blank.body).toEqual({ ok: true, note: "" });
      expect((await w.agent.get(`/api/git/agent-note/${c}/${enc}`)).body).toEqual({ note: "call Monday" });
      const bulk = await w.agent.get(`/api/git/agent-notes-bulk/${c}`);
      expect(bulk.body.notes).toEqual(
        expect.arrayContaining([
          { agentName: AGENT, note: "call Monday" },
          { agentName: "Other", note: "" },
        ])
      );
      expect((await w.agent.get(`/api/git/agent-note/${c}/Other`)).body).toEqual({ note: "" });
    }));

  it("validates adjustments, groups them by agent and deletes only the agent's own row", () =>
    withFactoryWorld(async (w) => {
      const base = `/api/git/agent-adjustments/${w.companyId}/${enc}`;
      const bad = [
        [{ description: "  ", amount: 5, type: "debit" }, "Description is required."],
        [{ description: "Fee", amount: "abc", type: "debit" }, "Amount must be a positive number."],
        [{ description: "Fee", amount: -3, type: "debit" }, "Amount must be a positive number."],
        [{ description: "Fee", type: "debit" }, "Amount must be a positive number."],
        [{ description: "Fee", amount: 5, type: "other" }, "Type must be 'debit' or 'credit'."],
        [{ amount: 5, type: "credit" }, "Description is required."],
      ] as const;
      for (const [payload, message] of bad) {
        const res = await w.agent.post(base).send(payload);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
      }
      expect((await w.agent.get(base)).body).toEqual([]);

      const debit = await w.agent.post(base).send({ description: " Fee ", amount: "12.50", type: "debit" });
      expect(debit.body).toMatchObject({ description: "Fee", amount: 12.5, type: "debit" });
      await w.agent.post(`/api/git/agent-adjustments/${w.companyId}/Other`).send({
        description: "Refund",
        amount: 4,
        type: "credit",
      });
      expect((await w.agent.get(base)).body).toEqual([expect.objectContaining({ id: debit.body.id, amount: 12.5 })]);
      const bulk = await w.agent.get(`/api/git/agent-adjustments-bulk/${w.companyId}`);
      expect(Object.keys(bulk.body.byAgent).sort()).toEqual([AGENT, "Other"]);
      expect(bulk.body.byAgent.Other[0]).toMatchObject({ description: "Refund", amount: 4, type: "credit" });

      // Deleting under the wrong agent leaves the row.
      expect((await w.agent.delete(`/api/git/agent-adjustments/${w.companyId}/Other/${debit.body.id}`)).body).toEqual({
        ok: true,
      });
      expect((await w.agent.get(base)).body).toHaveLength(1);
      await w.agent.delete(`${base}/${debit.body.id}`);
      expect((await w.agent.get(base)).body).toEqual([]);
    }));

  it("refuses a non-numeric company id at the company-scope boundary", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.get(`/api/git/agent-note/abc/${enc}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("COMPANY_ID_INVALID");
    }));
});

describe("prepaid designations", () => {
  it("replaces the list, dropping non-numeric ids", () =>
    withFactoryWorld(async (w) => {
      const a = await container(w, "A", "100");
      const b = await container(w, "B", "100");
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      const set = await w.agent.post(`${base}/set-all`).send({ containerIds: [a, "x", String(b)] });
      expect(set.body).toEqual({ ok: true, count: 2 });
      expect((await w.agent.get(base)).body.designations).toEqual([{ containerId: a }, { containerId: b }]);
      const cleared = await w.agent.post(`${base}/set-all`).send({});
      expect(cleared.body).toEqual({ ok: true, count: 0 });
      expect(await designations(w)).toEqual([]);
    }));

  it("refuses bad replace requests and swaps on confirmation", () =>
    withFactoryWorld(async (w) => {
      const oldId = await container(w, "OLD", "100");
      const sameDuty = await container(w, "SAME", "100.00");
      const dearer = await container(w, "DEAR", "150");
      const undesignated = await container(w, "FREE", null);
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      await w.agent.post(`${base}/set-all`).send({ containerIds: [oldId] });
      const replace = (body: Record<string, unknown>) => w.agent.post(`${base}/replace`).send(body);

      expect((await replace({ oldContainerId: oldId })).status).toBe(400);
      expect((await replace({ oldContainerId: oldId, newContainerId: oldId })).body.message).toMatch(/different/);
      const missingOld = await replace({ oldContainerId: 999999999, newContainerId: dearer });
      expect(missingOld.status).toBe(404);
      expect(missingOld.body.message).toMatch(/Old container/);
      const missingNew = await replace({ oldContainerId: oldId, newContainerId: 999999999 });
      expect(missingNew.status).toBe(404);
      expect(missingNew.body.message).toMatch(/New container/);
      const notDesignated = await replace({ oldContainerId: undesignated, newContainerId: dearer });
      expect(notDesignated.status).toBe(409);
      expect(notDesignated.body.message).toMatch(/not currently designated/);

      const differ = await replace({ oldContainerId: oldId, newContainerId: dearer });
      expect(differ.status).toBe(409);
      expect(differ.body).toMatchObject({ oldAmount: 100, newAmount: 150, requiresConfirmation: true });
      expect(await designations(w)).toEqual([{ container_id: oldId }]);

      const swapped = await replace({ oldContainerId: String(oldId), newContainerId: sameDuty });
      expect(swapped.body).toEqual({ ok: true, replaced: { from: `${w.tag}OLD`, to: `${w.tag}SAME` } });
      const confirmed = await replace({
        oldContainerId: sameDuty,
        newContainerId: dearer,
        confirmDifferentAmount: true,
      });
      expect(confirmed.status).toBe(200);
      expect(await designations(w)).toEqual([{ container_id: dearer }]);
      const log = await w.q(
        `SELECT old_container_number, new_container_number, amount::numeric::text AS amount
           FROM git_prepaid_activity_log WHERE company_id = $1 ORDER BY id`,
        [w.companyId]
      );
      expect(log.map((r) => [r.old_container_number, r.new_container_number, Number(r.amount)])).toEqual([
        [`${w.tag}OLD`, `${w.tag}SAME`, 100],
        [`${w.tag}SAME`, `${w.tag}DEAR`, 150],
      ]);
    }));
});

describe("prepaid replace with a missing duty fee", () => {
  it("refuses with 400 before the confirmation step, swapping and logging nothing", () =>
    withFactoryWorld(async (w) => {
      const oldId = await container(w, "OLD", "100");
      const noDuty = await container(w, "NODUTY", null);
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      const replace = (body: Record<string, unknown>) => w.agent.post(`${base}/replace`).send(body);
      await w.agent.post(`${base}/set-all`).send({ containerIds: [oldId] });

      // Missing duty fee on the new container, with and without confirmation.
      for (const confirmDifferentAmount of [undefined, true]) {
        const res = await replace({ oldContainerId: oldId, newContainerId: noDuty, confirmDifferentAmount });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(`Container ${w.tag}NODUTY has no valid duty fee.`);
      }
      expect(await designations(w)).toEqual([{ container_id: oldId }]);

      // Missing duty fee on the designated (old) container.
      await w.agent.post(`${base}/set-all`).send({ containerIds: [noDuty] });
      const res = await replace({ oldContainerId: noDuty, newContainerId: oldId, confirmDifferentAmount: true });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(`Container ${w.tag}NODUTY has no valid duty fee.`);
      expect(await designations(w)).toEqual([{ container_id: noDuty }]);

      const log = await w.q(`SELECT 1 FROM git_prepaid_activity_log WHERE company_id = $1`, [w.companyId]);
      expect(log).toEqual([]);
    }));
});

describe("database failures", () => {
  it("answers 500 when Postgres rejects a value, leaving nothing written", () =>
    withFactoryWorld(async (w) => {
      const failing = async (send: () => PromiseLike<{ status: number; body: { message?: string } }>) => {
        // Each failure aborts the statement; a savepoint keeps the test transaction usable.
        await w.q(`SAVEPOINT git_failure`);
        const res = await send();
        await w.q(`ROLLBACK TO SAVEPOINT git_failure`);
        expect(res.status).toBe(500);
        expect(res.body.message).toBeTruthy();
      };
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      await failing(() => w.agent.post(`${base}/set-all`).send({ containerIds: [1e12] }));
      await failing(() => w.agent.post(`${base}/replace`).send({ oldContainerId: "abc", newContainerId: "def" }));
      await failing(() =>
        w.agent
          .post(`/api/git/agent-adjustments/${w.companyId}/${enc}`)
          .send({ description: "Huge", amount: "1e30", type: "debit" })
      );
      await failing(() => w.agent.delete(`/api/git/agent-adjustments/${w.companyId}/${enc}/99999999999`));
      expect(await designations(w)).toEqual([]);
    }));
});

describe("company scope", () => {
  it("refuses another company's id on every route", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const calls = [
        () => w.agent.get(`/api/git/agent-note/${other}/${enc}`),
        () => w.agent.put(`/api/git/agent-note/${other}/${enc}`).send({ note: "x" }),
        () => w.agent.get(`/api/git/agent-notes-bulk/${other}`),
        () => w.agent.get(`/api/git/agent-adjustments-bulk/${other}`),
        () => w.agent.get(`/api/git/agent-adjustments/${other}/${enc}`),
        () =>
          w.agent
            .post(`/api/git/agent-adjustments/${other}/${enc}`)
            .send({ description: "x", amount: 1, type: "debit" }),
        () => w.agent.delete(`/api/git/agent-adjustments/${other}/${enc}/1`),
        () => w.agent.get(`/api/git/agent-prepaid/${other}/${enc}`),
        () => w.agent.post(`/api/git/agent-prepaid/${other}/${enc}/set-all`).send({ containerIds: [1] }),
        () =>
          w.agent.post(`/api/git/agent-prepaid/${other}/${enc}/replace`).send({ oldContainerId: 1, newContainerId: 2 }),
      ];
      for (const call of calls) {
        const res = await call();
        expect(res.status).toBe(403);
      }
      const written = await w.q(
        `SELECT (SELECT count(*) FROM git_agent_notes WHERE company_id = $1)::int AS notes,
                (SELECT count(*) FROM git_agent_adjustments WHERE company_id = $1)::int AS adjustments,
                (SELECT count(*) FROM git_prepaid_designations WHERE company_id = $1)::int AS prepaid`,
        [other]
      );
      expect(written).toEqual([{ notes: 0, adjustments: 0, prepaid: 0 }]);
    }));

  it("refuses to swap in another company's container without leaking its number", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const own = await container(w, "OWN", "100");
      const foreign = await container(w, "FOREIGN", "100", other);
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      await w.agent.post(`${base}/set-all`).send({ containerIds: [own] });
      const res = await w.agent.post(`${base}/replace`).send({ oldContainerId: own, newContainerId: foreign });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/New container/);
      expect(JSON.stringify(res.body)).not.toContain(`${w.tag}FOREIGN`);
      expect(await designations(w)).toEqual([{ container_id: own }]);
      const log = await w.q(`SELECT 1 FROM git_prepaid_activity_log WHERE company_id = $1`, [w.companyId]);
      expect(log).toEqual([]);
    }));

  it("set-all refuses another company's or a missing container and keeps the list", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const own = await container(w, "OWN", "100");
      const foreign = await container(w, "FOREIGN", "100", other);
      const base = `/api/git/agent-prepaid/${w.companyId}/${enc}`;
      await w.agent.post(`${base}/set-all`).send({ containerIds: [own] });
      for (const ids of [
        [own, foreign],
        [own, 999999999],
      ]) {
        const res = await w.agent.post(`${base}/set-all`).send({ containerIds: ids });
        expect(res.status).toBe(404);
        expect(res.body.message).toContain(String(ids[1]));
      }
      expect(await designations(w)).toEqual([{ container_id: own }]);
    }));
});
