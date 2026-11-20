/**
 * USD inter-company transfers over HTTP (POST /api/inter-company-transfers):
 * a retry with the same clientRequestId replays the first transfer, with one
 * voucher per side whose number derives from the clientRequestId; a
 * different clientRequestId posts a second transfer. One rolled-back
 * transaction per test.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/inter-company-transfers";

async function pair(w: FactoryWorld) {
  const other = await w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD')
     RETURNING id`,
    [`${w.tag}I`]
  );
  await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [w.userId, other]);
  const cash = (companyId: number, code: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Cash')
       RETURNING id`,
      [companyId, `${w.tag}${code}`]
    );
  return { other, fromCash: await cash(w.companyId, "F"), toCash: await cash(other, "T") };
}

function body(w: FactoryWorld, p: Awaited<ReturnType<typeof pair>>, clientRequestId: string) {
  return {
    transferType: "Cash",
    fromCompanyId: w.companyId,
    toCompanyId: p.other,
    fromLedgerAccountId: p.fromCash,
    toLedgerAccountId: p.toCash,
    amount: "120.00",
    transferDate: "2026-03-02",
    description: "Loan top-up",
    clientRequestId,
  };
}

async function ictVouchers(w: FactoryWorld, other: number) {
  return w.q<{ company_id: number; voucher_number: string }>(
    `SELECT company_id, voucher_number FROM vouchers
      WHERE company_id = ANY($1::int[]) AND voucher_number LIKE 'ICT-%' ORDER BY id`,
    [[w.companyId, other]]
  );
}

describe("USD inter-company transfer retries", () => {
  it("replays a retry with the same clientRequestId with one voucher per side", () =>
    withFactoryWorld(async (w) => {
      const p = await pair(w);
      const created = await w.agent.post(URL).send(body(w, p, `${w.tag}-ict`));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const retry = await w.agent.post(URL).send(body(w, p, `${w.tag}-ict`));
      expect(retry.status, JSON.stringify(retry.body)).toBe(201);
      expect(retry.body).toMatchObject({
        id: created.body.id,
        fromVoucherId: created.body.fromVoucherId,
        toVoucherId: created.body.toVoucherId,
      });

      const transfers = await w.q(
        `SELECT id FROM inter_company_transfers WHERE from_company_id = $1 AND to_company_id = $2`,
        [w.companyId, p.other]
      );
      expect(transfers).toEqual([{ id: created.body.id }]);
      expect(await ictVouchers(w, p.other)).toEqual([
        { company_id: w.companyId, voucher_number: expect.stringMatching(/^ICT-FROM-[0-9a-f]{24}$/) },
        { company_id: p.other, voucher_number: expect.stringMatching(/^ICT-TO-[0-9a-f]{24}$/) },
      ]);
    }));

  it("posts a second transfer for a different clientRequestId", () =>
    withFactoryWorld(async (w) => {
      const p = await pair(w);
      const first = await w.agent.post(URL).send(body(w, p, `${w.tag}-a`));
      const second = await w.agent.post(URL).send(body(w, p, `${w.tag}-b`));
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body.id).not.toBe(first.body.id);
      const numbers = (await ictVouchers(w, p.other)).map((v) => v.voucher_number);
      expect(numbers).toHaveLength(4);
      expect(new Set(numbers).size).toBe(4);
    }));
});
