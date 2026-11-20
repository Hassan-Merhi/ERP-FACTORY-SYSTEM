/**
 * POST /api/properties/repair/reallocate-payments/:contractId and the
 * label/fallback edges of the balance-repair scan and apply, through the
 * real app inside one rolled-back transaction.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { seedBalanceRepair } from "./helpers/balanceRepairFixture";

const URL = "/api/properties/repair/reallocate-payments";

async function contractWorld(w: FactoryWorld, companyId = w.companyId) {
  const unit = await w.one(
    `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, 'PROPERTIES', 'WAREHOUSE', $2, 'Block', true) RETURNING id`,
    [companyId, `${w.tag}R${companyId}`]
  );
  const contract = await w.one(
    `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
     VALUES ($1, 'PROPERTIES', $2, 'Realloc', '100.00', '2026-01-01', 'ACTIVE', 'USD') RETURNING id`,
    [companyId, unit]
  );
  const ledger = (month: number, expected: string, paid: string) =>
    w.one(
      `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
       VALUES ($1, 'PROPERTIES', $2, $3, 2026, $4, $5, $6) RETURNING id`,
      [companyId, contract, unit, month, expected, paid]
    );
  const payment = (amount: string, day: string, month: number, ledgerRow: number | null, notes: string | null = null) =>
    w.one(
      `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
         ledger_row_id, notes)
       VALUES ($1, 'PROPERTIES', $2, $3, $4, $5::date, 2026, $6, $7, $8) RETURNING id`,
      [companyId, contract, unit, amount, day, month, ledgerRow, notes]
    );
  return { unit, contract, ledger, payment };
}

const ledgerOf = (w: FactoryWorld, contract: number) =>
  w.q<{ month: number; paid: string }>(
    `SELECT month, paid_amount::text AS paid FROM property_monthly_ledger WHERE contract_id = $1 ORDER BY month`,
    [contract]
  );

describe("reallocate payments", () => {
  it("rejects a bad id and another company's contract without writing", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post(`${URL}/abc`).send({})).status).toBe(400);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}Q`,
      ]);
      const theirs = await contractWorld(w, other);
      await theirs.ledger(1, "100.00", "77.00");
      const res = await w.agent.post(`${URL}/${theirs.contract}`).send({});
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Contract not found");
      expect(await ledgerOf(w, theirs.contract)).toEqual([{ month: 1, paid: "77.00" }]);
    }));

  it("syncs ghost amounts and drops empty prepaid rows when no rent payment exists", () =>
    withFactoryWorld(async (w) => {
      const c = await contractWorld(w);
      await c.ledger(1, "100.00", "40.00");
      await c.ledger(2, "0.00", "25.00");
      await c.payment("40.00", "2026-01-05", 1, null, "[Guarantee release] moved");
      const res = await w.agent.post(`${URL}/${c.contract}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ fixed: 0, message: "Ledger amounts synced (no rent payments to reallocate)." });
      expect(await ledgerOf(w, c.contract)).toEqual([{ month: 1, paid: "0.00" }]);
    }));

  it("reports when payments exist but every ledger row was removed", () =>
    withFactoryWorld(async (w) => {
      const c = await contractWorld(w);
      await c.ledger(1, "0.00", "0.00");
      await c.payment("30.00", "2026-01-05", 1, null);
      const res = await w.agent.post(`${URL}/${c.contract}`).send({});
      expect(res.body).toEqual({ fixed: 0, message: "Ledger amounts synced (no ledger rows found)." });
      expect(await ledgerOf(w, c.contract)).toEqual([]);
    }));

  it("re-allocates rent payments to the oldest open months", () =>
    withFactoryWorld(async (w) => {
      const c = await contractWorld(w);
      const jan = await c.ledger(1, "100.00", "0.00");
      const feb = await c.ledger(2, "100.00", "0.00");
      const mar = await c.ledger(3, "100.00", "0.00");
      const first = await c.payment("150.00", "2026-01-05", 3, mar);
      const second = await c.payment("100.00", "2026-02-05", 1, jan);
      const third = await c.payment("80.00", "2026-03-05", 3, mar, "[Guarantee applied]");
      const fourth = await c.payment("90.00", "2026-04-05", 3, null);
      const res = await w.agent.post(`${URL}/${c.contract}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ fixed: 3, total: 3, message: "Reallocated 3 payment(s) to the correct months." });
      expect(await ledgerOf(w, c.contract)).toEqual([
        { month: 1, paid: "100.00" },
        { month: 2, paid: "100.00" },
        { month: 3, paid: "100.00" },
      ]);
      const rows = await w.q(
        `SELECT id, for_month, ledger_row_id FROM property_payments WHERE id = ANY($1::int[]) ORDER BY id`,
        [[first, second, third, fourth]]
      );
      // The guarantee payment is left alone; the last payment fills March and
      // its 40.00 overpayment finds no open month.
      expect(rows.map((r) => [r.for_month, r.ledger_row_id === null ? null : Number(r.ledger_row_id)])).toEqual([
        [1, jan],
        [2, feb],
        [3, mar],
        [3, mar],
      ]);
    }));
});

describe("balance repair label fallbacks", () => {
  it("labels rows whose contract or unit lives elsewhere and repairs them", () =>
    withFactoryWorld(async (w) => {
      const seed = await seedBalanceRepair(w);
      const [otherUnit] = await w.q<{ id: number }>(`SELECT id FROM property_units WHERE unit_number = $1`, [
        `${w.tag}OW`,
      ]);
      // A contract of this company on a unit of the other company.
      const strayContract = await w.one(
        `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, start_date, guarantee_amount,
           guarantee_posted_to_statement)
         VALUES ($1, 'PROPERTIES', $2, 'Stray', '2026-01-01', 10, true) RETURNING id`,
        [w.companyId, otherUnit.id]
      );
      const strayLedger = await w.one(
        `INSERT INTO property_monthly_ledger (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
         VALUES ($1, 'PROPERTIES', $2, $3, 2026, 6, '10.00', '5.00') RETURNING id`,
        [w.companyId, seed.otherContractId, otherUnit.id]
      );
      const bare = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Receipt', '2026-05-10', 9) RETURNING id`,
        [w.companyId, `${w.tag}-BARE`]
      );
      await w.q(
        `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
           voucher_id, cash_account_id)
         VALUES ($1, 'PROPERTIES', $2, $3, 9, '2026-05-10', 2026, 5, $4, $5)`,
        [w.companyId, seed.otherContractId, otherUnit.id, bare, seed.cashId]
      );
      await w.q(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, 'GUAR-NOTANID', 'Receipt', '2026-05-10', 1)`,
        [w.companyId]
      );

      // Flag mismatches on a unit of the other company.
      const flagContract = (flag: boolean, posted: string) =>
        w.one(
          `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, start_date, guarantee_amount,
             guarantee_posted_to_statement, guarantee_posted_amount)
           VALUES ($1, 'PROPERTIES', $2, 'Stray flag', '2026-01-01', 20, $3, $4) RETURNING id`,
          [w.companyId, otherUnit.id, flag, posted]
        );
      const strayMissing = await flagContract(false, "0");
      const strayMismatch = await flagContract(true, "15");
      for (const [cid, total] of [
        [strayMissing, 20],
        [strayMismatch, 20],
      ]) {
        await w.q(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Receipt', '2026-05-10', $3)`,
          [w.companyId, `GUAR-${w.tag}-${cid}`, total]
        );
      }
      // A shop rent voucher with no description, and transfers whose broken
      // side is an empty FROM voucher or a soft-deleted TO voucher.
      const shopBare = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Payment', '2026-05-10', 8) RETURNING id`,
        [w.companyId, `${w.tag}-SB`]
      );
      await w.q(
        `INSERT INTO property_payments (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month,
           voucher_id, cash_account_id)
         VALUES ($1, 'PROPERTIES', $2, $3, 8, '2026-05-10', 2026, 5, $4, $5)`,
        [w.companyId, seed.shopContractId, seed.shopUnitId, shopBare, seed.cashId]
      );
      const v = (cid: number, n: string, deleted: boolean) =>
        w.one(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, deleted_at)
           VALUES ($1, $2, 'Journal', '2026-05-10', 5, CASE WHEN $3::boolean THEN now() ELSE NULL END) RETURNING id`,
          [cid, `${w.tag}-${n}`, deleted]
        );
      const withLines = async (id: number, a: number, b: number) => {
        await w.q(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
           VALUES ($1, $2, 5, 0), ($1, $3, 0, 5)`,
          [id, a, b]
        );
        return id;
      };
      const [oc] = await w.q<{ id: number }>(`SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id`, [
        seed.otherCompanyId,
      ]);
      const [oi] = await w.q<{ id: number }>(`SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id DESC`, [
        seed.otherCompanyId,
      ]);
      const emptyFrom = await v(w.companyId, "EF", false);
      const liveTo = await withLines(await v(seed.otherCompanyId, "LT", false), oc.id, oi.id);
      const [mine] = await w.q<{ id: number }>(
        `SELECT id FROM ledger_accounts WHERE company_id = $1 AND id <> $2 ORDER BY id LIMIT 1`,
        [w.companyId, seed.cashId]
      );
      const liveFrom = await withLines(await v(w.companyId, "LF", false), seed.cashId, mine.id);
      const deletedTo = await v(seed.otherCompanyId, "DT", true);
      const link = (from: number, to: number) =>
        w.one(
          `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
             from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id)
           VALUES ('Cash', $1, $2, '2026-05-10', 5, $3, $4, $5, $6) RETURNING id`,
          [w.companyId, seed.otherCompanyId, seed.cashId, oc.id, from, to]
        );
      const emptyFromLink = await link(emptyFrom, liveTo);
      const deletedToLink = await link(liveFrom, deletedTo);

      const scan = await w.agent.get("/api/admin/repair-balances/scan");
      expect(scan.status).toBe(200);
      const drift = scan.body.ledgerDrifts.find((d: { id: number }) => d.id === strayLedger);
      expect(drift).toMatchObject({ tenantName: `Contract #${seed.otherContractId}` });
      expect(drift.unitLabel).toBe(`Unit#${otherUnit.id}`);
      const missing = scan.body.voucherEntryMissing.find((m: { voucherId: number }) => m.voucherId === bare);
      expect(missing).toMatchObject({
        module: "PROPERTIES",
        tenantName: `Contract #${seed.otherContractId}`,
        unitLabel: `Unit#${otherUnit.id}`,
      });
      const stale = scan.body.depositFlagMismatches.find((d: { contractId: number }) => d.contractId === strayContract);
      expect(stale).toMatchObject({ issue: "STALE_FLAG", unitLabel: `Unit#${otherUnit.id}`, guaranteeAmount: 0 });

      const flags = new Map(
        scan.body.depositFlagMismatches.map((d: { contractId: number; issue: string }) => [d.contractId, d.issue])
      );
      expect(flags.get(strayMissing)).toBe("MISSING_FLAG");
      expect(flags.get(strayMismatch)).toBe("AMOUNT_MISMATCH");
      const orphans = new Map(
        scan.body.orphanedTransfers.map((o: { transferId: number }) => [o.transferId, o] as const)
      );
      expect(orphans.get(emptyFromLink)).toMatchObject({
        orphanedSide: "FROM",
        issue: "EMPTY_ENTRIES",
        description: "",
      });
      expect(orphans.get(deletedToLink)).toMatchObject({ orphanedSide: "TO", issue: "SOFT_DELETED" });

      const apply = await w.agent.post("/api/admin/repair-balances/apply").send({});
      const shopLines = await w.q(`SELECT narration FROM voucher_entries WHERE voucher_id = $1`, [shopBare]);
      expect(shopLines.map((l) => l.narration)).toEqual(["Rent paid", "Rent paid"]);
      const left = await w.q(`SELECT id FROM inter_company_transfers WHERE id = ANY($1::int[])`, [
        [emptyFromLink, deletedToLink],
      ]);
      expect(left).toEqual([]);
      expect(apply.status).toBe(200);
      const lines = await w.q(`SELECT narration FROM voucher_entries WHERE voucher_id = $1`, [bare]);
      expect(lines.map((l) => l.narration)).toEqual(["Rent received", "Rent received"]);
    }));
});
