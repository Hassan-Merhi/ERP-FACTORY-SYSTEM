/**
 * Production Targets bonus history report (route + report adapter) and the
 * read-only preview / append-only rate settings routes, over HTTP against
 * PostgreSQL in one rolled-back transaction per test.
 *
 * Pinned: Admin-only access, range and worker validation, the status each
 * award is reported with (draft, pending, approved, rejected, posted, voided),
 * saved reviews that no longer have an operational row, and idempotent rate
 * writes that refuse a reused request key.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createBonusWorld } from "./helpers/productionBonusFixture";

const REPORT = "/api/factory/production-target-bonuses/report";
const PREVIEW = "/api/factory/production-target-bonuses/preview";
const SETTINGS = "/api/factory/production-target-bonuses/settings";

const report = (w: FactoryWorld, query: Record<string, unknown>) => w.agent.get(REPORT).query({ ...query });

describe("production target bonus history report", () => {
  it("validates the range, the span and the worker id", async () => {
    await withFactoryWorld(async (w) => {
      for (const query of [
        { start: "bad", end: "2026-01-01" },
        { start: "2026-02-01", end: "2026-01-01" },
        { start: "2025-01-01", end: "2026-02-01" },
        { start: "2026-01-01", end: "2026-01-02", workerId: "abc" },
        { start: "2026-01-01", end: "2026-01-02", workerId: "-3" },
      ]) {
        expect((await report(w, query)).status).toBe(400);
      }
      const owner = await w.agentFor("Owner");
      expect((await owner.get(REPORT).query({ start: "2026-01-01", end: "2026-01-02" })).status).toBe(403);
    });
  });

  it("reports every award status across windows and keeps saved reviews without a live row", async () => {
    await withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      await b.rate("company", "1.5");
      const draft = await b.worker("A Draft");
      const pending = await b.worker("B Pending");
      const approved = await b.worker("C Approved");
      const rejected = await b.worker("D Rejected");
      const posted = await b.worker("E Posted");
      const voided = await b.worker("F Voided");
      const orphan = await b.worker("G Orphan", false);
      const day = "2026-01-06";
      await b.day(day, draft, 5, 5);
      await b.day(day, pending, 5, 7);
      for (const id of [approved, rejected, posted, voided]) await b.day(day, id, 5, 7);
      await b.review(day, approved, { amount: "3.00" });
      await b.review(day, rejected, { status: "rejected", amount: "3.00" });
      const postedReview = await b.review(day, posted, { amount: "3.00" });
      await b.dailyPayment(postedReview, day, posted, "3.00");
      const voidedReview = await b.review(day, voided, { amount: "3.00" });
      await b.dailyPayment(voidedReview, day, voided, "3.00", "REVERSED");
      // Saved review in a later window whose operational day row is gone.
      await b.review("2026-02-20", orphan, { amount: "4.00", extra: "4", rate: "1" });

      const res = await report(w, { start: "2026-01-01", end: "2026-03-01" });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      type Row = { workerId: number; productionDate: string };
      const at = (workerId: number, date = day) =>
        res.body.rows.find((r: Row) => r.workerId === workerId && r.productionDate === date);
      const byWorker = { get: (workerId: number) => at(workerId, workerId === orphan ? "2026-02-20" : day) };
      expect(byWorker.get(draft)).toMatchObject({ status: "DRAFT", amount: "0.00" });
      expect(byWorker.get(pending)).toMatchObject({ status: "PENDING", amount: "3.00", bonusPerExtraBale: "1.5000" });
      expect(byWorker.get(approved)).toMatchObject({ status: "APPROVED", paymentVoucherId: null });
      expect(byWorker.get(rejected)).toMatchObject({ status: "REJECTED", approvedAt: null });
      expect(byWorker.get(posted)).toMatchObject({ status: "POSTED", paymentAccountNameSnapshot: `${b.tag}CASH` });
      expect((byWorker.get(posted) as { paymentVoucherId: number }).paymentVoucherId).toBeGreaterThan(0);
      expect(byWorker.get(voided)).toMatchObject({ status: "VOIDED", postedAt: null });
      expect(byWorker.get(orphan)).toMatchObject({ status: "APPROVED", productionDate: "2026-02-20", amount: "4.00" });

      const one = await report(w, { start: "2026-01-01", end: "2026-01-31", workerId: String(pending) });
      expect(one.status).toBe(200);
      expect(new Set(one.body.rows.map((r: { workerId: number }) => r.workerId))).toEqual(new Set([pending]));
    });
  });

  it("fails closed when a posted claim has no matching voucher evidence", async () => {
    await withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      const worker = await b.worker("No Evidence");
      const reviewId = await b.review("2026-01-06", worker, { amount: "3.00" });
      const paymentId = await b.dailyPayment(reviewId, "2026-01-06", worker, "3.00");
      const otherCompany = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${b.tag}X`]
      );
      const foreignCash = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
         VALUES ($1, $2::varchar, $2::text, 'Cash', '0', TRUE) RETURNING id`,
        [otherCompany, `${b.tag}XCASH`]
      );
      await w.q(`UPDATE factory_target_bonus_payments SET cash_ledger_account_id = $1 WHERE id = $2`, [
        foreignCash,
        paymentId,
      ]);
      const res = await report(w, { start: "2026-01-01", end: "2026-01-31" });
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/lacks matching voucher\/account evidence/);
    });
  });
});

describe("production target bonus preview", () => {
  it("refuses non-admin roles and bad ranges", async () => {
    await withFactoryWorld(async (w) => {
      for (const query of [
        {},
        { startDate: "2026-02-30", endDate: "2026-03-01" },
        { startDate: "2026-03-02", endDate: "2026-03-01" },
        { startDate: "2099-01-01", endDate: "2099-01-02" },
        { startDate: "2025-01-01", endDate: "2025-12-31" },
      ]) {
        expect((await w.agent.get(PREVIEW).query({ ...query })).status).toBe(400);
      }
      const manager = await w.agentFor("Manager");
      const res = await manager.get(PREVIEW).query({ startDate: "2026-01-05", endDate: "2026-01-06" });
      expect(res.status).toBe(403);
    });
  });

  it("proposes bonuses for finalized days and includes linked workers", async () => {
    await withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      await b.rate("company", "2");
      const a = await b.worker("Linked A");
      const c = await b.worker("Linked B");
      await b.day("2026-01-06", a, 5, 8);
      await b.day("2026-01-06", c, 5, 5);
      await w.q(
        `UPDATE factory_staff_tracking_entries SET produced_bales = 8, status = 'Absent'
          WHERE company_id = $1 AND person_id = $2`,
        [w.companyId, c]
      );
      const linkId = await w.one(
        `INSERT INTO factory_worker_production_links (company_id, effective_from, created_by)
         VALUES ($1, '2026-01-01', 'fixture') RETURNING id`,
        [w.companyId]
      );
      for (const id of [a, c]) {
        await w.q(
          `INSERT INTO factory_worker_production_link_members (company_id, link_id, worker_id) VALUES ($1, $2, $3)`,
          [w.companyId, linkId, id]
        );
      }
      const res = await w.agent.get(PREVIEW).query({ startDate: "2026-01-05", endDate: "2026-01-06" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ proposalOnly: true, canPost: false, finalizedDays: 1, currency: "USD" });
      expect(res.body.days).toHaveLength(2);
      expect(res.body.days[1].finalized).toBe(true);
    });
  });
});

describe("production target bonus rate settings", () => {
  const key = (s: string) => `req-key-${s}`;

  it("validates, appends a company and a worker rate, replays and refuses a reused key", async () => {
    await withFactoryWorld(async (w) => {
      const b = await createBonusWorld(w.client, w.companyId);
      const worker = await b.worker("Rated");
      const base = { scope: "company", effectiveFrom: "2026-01-01", enabled: true, ratePerExtraBale: "1.5" };
      for (const bad of [
        { ...base, scope: "team" },
        { ...base, effectiveFrom: "2026-13-01" },
        { ...base, enabled: "yes" },
        { ...base, ratePerExtraBale: "99999" },
        { ...base, ratePerExtraBale: { v: 1 } },
        { ...base, requestKey: "short" },
        { ...base, workerId: worker, requestKey: key("a1") },
        { ...base, scope: "worker", workerId: -1, requestKey: key("a2") },
      ]) {
        expect((await w.agent.post(SETTINGS).send(bad)).status).toBe(400);
      }
      const missing = await w.agent
        .post(SETTINGS)
        .send({ ...base, scope: "worker", workerId: 999999999, requestKey: key("missing") });
      expect(missing.status).toBe(404);

      const created = await w.agent.post(SETTINGS).send({ ...base, note: " first ", requestKey: key("company") });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ replayed: false, currency: "USD" });
      const replay = await w.agent.post(SETTINGS).send({ ...base, note: "first", requestKey: key("company") });
      expect(replay.body).toMatchObject({ versionId: created.body.versionId, replayed: true });
      const conflict = await w.agent.post(SETTINGS).send({ ...base, ratePerExtraBale: 2, requestKey: key("company") });
      expect(conflict.status).toBe(409);

      const workerRate = await w.agent
        .post(SETTINGS)
        .send({ ...base, scope: "worker", workerId: worker, ratePerExtraBale: 3, requestKey: key("worker") });
      expect(workerRate.status).toBe(201);
      const rows = await w.q(`SELECT scope FROM factory_production_target_bonus_rates WHERE company_id = $1`, [
        w.companyId,
      ]);
      expect(rows).toHaveLength(2);

      const read = await w.agent.get(SETTINGS).query({ asOf: "2026-02-01" });
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ asOf: "2026-02-01", historyTruncated: false, payoutsEnabled: false });
      expect(read.body.workerRates.map((r: { workerId: number }) => r.workerId)).toEqual([worker]);
      expect((await w.agent.get(SETTINGS)).status).toBe(200);
      expect((await w.agent.get(SETTINGS).query({ asOf: "nope" })).status).toBe(400);

      const manager = await w.agentFor("Manager");
      expect((await manager.get(SETTINGS)).status).toBe(403);
      expect((await manager.post(SETTINGS).send({ ...base, requestKey: key("manager") })).status).toBe(403);
    });
  });
});
