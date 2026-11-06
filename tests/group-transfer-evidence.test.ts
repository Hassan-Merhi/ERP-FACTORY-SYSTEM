/**
 * Intercompany Cash/Loan transfer evidence: each leg is read in its own
 * company scope, and every way a pair can fail (missing, retired, wrong
 * account, date, direction, amount) is reported without changing anything.
 * The database and the group company scope are stubbed.
 */
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  transfers: new Map<number, Row[]>(),
  vouchers: new Map<string, Row>(),
  scopes: [] as number[],
  asserted: [] as number[],
  queries: [] as Array<{ text: string; params: unknown[] }>,
}));

vi.mock("../server/db", async () => {
  const { PgDialect: Dialect } = await import("drizzle-orm/pg-core");
  const dialect = new Dialect();
  const tx = {
    execute: async (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      h.queries.push({ text, params });
      if (text.includes("FROM inter_company_transfers")) return { rows: h.transfers.get(Number(params[0])) ?? [] };
      // params: accountId, voucherId, companyId, asOf
      const leg = h.vouchers.get(`${params[2]}:${params[1]}`);
      return { rows: leg ? [{ ...leg, ledger_signed: (leg.byAccount as Row)?.[String(params[0])] ?? null }] : [] };
    },
  };
  return { db: { transaction: async (work: (t: unknown) => unknown) => work(tx) } };
});
vi.mock("../server/services/security/transactionCompanyScope", () => ({
  assertTransactionCompanyScope: async (_tx: unknown, companyId: number) => void h.asserted.push(companyId),
}));
vi.mock("../server/helpers/groupNetPosition", () => ({
  runWithGroupCompanyScope: async (companyId: number, _allowed: unknown, work: () => unknown) => {
    h.scopes.push(companyId);
    return work();
  },
}));

import { intercompanyTransferEvidence } from "../server/services/accounting/groupTransferEvidence";

const allowed = new Set([1, 2, 3]);
const transfer = (over: Row = {}): Row => ({
  id: 10,
  from_company_id: 1,
  to_company_id: 2,
  from_ledger_account_id: 100,
  to_ledger_account_id: 200,
  from_voucher_id: 501,
  to_voucher_id: 502,
  transfer_date: "2026-10-10",
  amount: "250.004",
  transfer_type: "cash",
  ...over,
});
const leg = (company: number, id: number, account: number, signed: string, over: Row = {}) =>
  h.vouchers.set(`${company}:${id}`, {
    id,
    voucher_number: `V-${id}`,
    booked_on: "2026-10-10",
    deleted_at: null,
    optional: false,
    source_company: company,
    byAccount: { [account]: signed },
    ...over,
  });

async function evidence(rows: Row[], companyIds: number[] = [1, 2]) {
  h.transfers.set(1, rows);
  return intercompanyTransferEvidence({ companyIds, allowedCompanyIds: allowed, asOfDate: "2026-10-30" });
}

beforeEach(() => {
  h.transfers = new Map();
  h.vouchers = new Map();
  h.scopes = [];
  h.asserted = [];
  h.queries = [];
  leg(1, 501, 100, "-250.00");
  leg(2, 502, 200, "250.00");
});

describe("intercompanyTransferEvidence", () => {
  it("accepts only 1 to 50 authorized company ids", async () => {
    const message = "Intercompany transfer audit only accepts authorized group members";
    for (const companyIds of [[], [1, 9], [1, 1.5], Array.from({ length: 51 }, () => 1)]) {
      await expect(
        intercompanyTransferEvidence({ companyIds, allowedCompanyIds: allowed, asOfDate: "2026-10-30" })
      ).rejects.toThrow(message);
    }
    expect(h.queries).toEqual([]);
  });

  it("matches opposite equal legs, each read in its own company scope", async () => {
    const out = await evidence([transfer()]);
    expect(out.rows).toEqual([
      {
        transferId: 10,
        type: "cash",
        fromCompanyId: 1,
        toCompanyId: 2,
        transferDate: "2026-10-10",
        amountSourceUsd: "250.00",
        fromVoucherId: 501,
        toVoucherId: 502,
        fromVoucherNumber: "V-501",
        toVoucherNumber: "V-502",
        sourceSideUsd: "-250.00",
        destinationSideUsd: "250.00",
        status: "matched",
        explanation: "Both live same-day linked transfer legs have opposite equal historical USD balances",
      },
    ]);
    expect(out.summary).toEqual({ total: 1, matched: 1, flagged: 0, truncated: false });
    expect(out).toMatchObject({ asOfDate: "2026-10-30", companyIds: [1, 2] });
    expect(out.policy).toContain("No vouchers were changed.");
    // Source lists for 1 and 2, then the from-leg in 1 and the to-leg in 2.
    expect(h.scopes).toEqual([1, 2, 1, 2]);
    expect(h.asserted).toEqual([1, 2, 1, 2]);
    const legQuery = h.queries.find((q) => q.text.includes("FROM vouchers v"));
    expect(legQuery?.params).toEqual([100, 501, 1, "2026-10-30"]);
    const sourceQuery = h.queries.find((q) => q.text.includes("FROM inter_company_transfers"));
    expect(sourceQuery?.params).toEqual([1, "2026-10-30"]);
    expect(sourceQuery?.text).toContain("LIMIT 251");
  });

  it("drops transfers to companies outside the audited set and flags truncation", async () => {
    const many = Array.from({ length: 251 }, (_, i) => transfer({ id: i + 1, to_company_id: i === 0 ? 3 : 2 }));
    const out = await evidence(many);
    expect(out.summary.truncated).toBe(true);
    expect(out.rows).toHaveLength(249);
    expect(out.rows.some((r) => r.toCompanyId === 3)).toBe(false);
    expect(out.rows.at(-1)?.transferId).toBe(250);

    const exact = await evidence(Array.from({ length: 250 }, (_, i) => transfer({ id: i + 1 })));
    expect(exact.summary.truncated).toBe(false);
    expect(exact.rows).toHaveLength(250);
  });

  it("reports missing legs, including unlinked and out-of-scope vouchers", async () => {
    const cases: Array<[Row, string, string]> = [
      [{ from_voucher_id: null }, "missing_from_voucher", "Source company's voucher leg is missing"],
      [{ from_voucher_id: 999 }, "missing_from_voucher", "Source company's voucher leg is missing"],
      [{ to_voucher_id: null }, "missing_to_voucher", "Destination company's linked voucher leg is missing"],
      [{ to_voucher_id: 999 }, "missing_to_voucher", "Destination company's linked voucher leg is missing"],
    ];
    for (const [over, status, explanation] of cases) {
      const [row] = (await evidence([transfer(over)])).rows;
      expect(row.status).toBe(status);
      expect(row.explanation).toContain(explanation);
    }
    const [unlinked] = (await evidence([transfer({ from_voucher_id: null, to_voucher_id: null })])).rows;
    expect(unlinked).toMatchObject({
      fromVoucherId: null,
      toVoucherId: null,
      fromVoucherNumber: null,
      toVoucherNumber: null,
      sourceSideUsd: null,
      destinationSideUsd: null,
    });
  });

  it("flags retired legs, a missing ledger line, dates, directions and amounts", async () => {
    const statusFor = async (setup: () => void, over: Row = {}) => {
      leg(1, 501, 100, "-250.00");
      leg(2, 502, 200, "250.00");
      setup();
      const [row] = (await evidence([transfer(over)])).rows;
      return [row.status, row.explanation];
    };
    expect(await statusFor(() => leg(1, 501, 100, "-250.00", { deleted_at: "2026-10-11" }))).toEqual([
      "retired_leg",
      "One or both source vouchers are deleted/optional; not a live paired transfer",
    ]);
    for (const over of [{ deleted_at: "x" }, { optional: true }]) {
      expect((await statusFor(() => leg(2, 502, 200, "250.00", over)))[0]).toBe("retired_leg");
    }
    expect((await statusFor(() => leg(1, 501, 100, "-250.00", { optional: true })))[0]).toBe("retired_leg");

    // The voucher exists but has no line on the linked intercompany account.
    expect(await statusFor(() => leg(1, 501, 101, "-250.00"))).toEqual([
      "missing_ledger_leg",
      "At least one voucher lacks the specifically linked intercompany ledger account",
    ]);
    leg(1, 501, 100, "-250.00");
    const [noToLine] = (await evidence([transfer({ to_ledger_account_id: 201 })])).rows;
    expect(noToLine).toMatchObject({
      status: "missing_ledger_leg",
      destinationSideUsd: null,
      sourceSideUsd: "-250.00",
    });

    expect((await statusFor(() => leg(1, 501, 100, "-250.00", { booked_on: "2026-10-11" })))[0]).toBe("date_mismatch");
    expect(await statusFor(() => leg(2, 502, 200, "250.00", { booked_on: "2026-10-09" }))).toEqual([
      "date_mismatch",
      "A voucher's effective posting date differs from the intercompany transfer's date",
    ]);

    for (const [from, to] of [
      ["250.00", "250.00"],
      ["-250.00", "-250.00"],
      ["0", "250.00"],
    ]) {
      expect(
        await statusFor(() => {
          leg(1, 501, 100, from);
          leg(2, 502, 200, to);
        })
      ).toEqual(["direction_mismatch", "Intercompany account legs must have opposite debit/credit signs"]);
    }

    expect(await statusFor(() => leg(2, 502, 200, "249.98"))).toEqual([
      "amount_mismatch",
      "One or both ledger-side USD amounts differ from the transfer source record",
    ]);
    // Legs agree with each other but not with the transfer amount.
    expect(
      (
        await statusFor(() => {
          leg(1, 501, 100, "-240.00");
          leg(2, 502, 200, "240.00");
        })
      )[0]
    ).toBe("amount_mismatch");
    // A cent of rounding on either check is tolerated.
    expect((await statusFor(() => leg(2, 502, 200, "250.01")))[0]).toBe("matched");
    expect((await statusFor(() => undefined, { amount: "249.99" }))[0]).toBe("matched");
  });

  it("summarises matched and flagged transfers", async () => {
    const out = await evidence([transfer(), transfer({ id: 11, to_voucher_id: null }), transfer({ id: 12 })]);
    expect(out.summary).toEqual({ total: 3, matched: 2, flagged: 1, truncated: false });
  });
});
