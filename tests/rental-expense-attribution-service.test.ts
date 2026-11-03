/**
 * Rental expense attribution: input checks, contract ownership, request-ID
 * replay and conflicts, the live-expense voucher checks, overallocation
 * across contracts, listing and voiding. The transaction, company scope,
 * business date and audit log are stubbed; queries are recognised by text.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  scope: vi.fn(),
  businessDate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../server/services/security/transactionCompanyScope", () => ({
  assertTransactionCompanyScope: (...a: unknown[]) => h.scope(...a),
}));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({
  companyBusinessDate: (...a: unknown[]) => h.businessDate(...a),
}));
vi.mock("../server/services/audit", () => ({ writeAuditEvent: (...a: unknown[]) => h.audit(...a) }));

import {
  linkRentalExpenseTx,
  listRentalExpenseLinksTx,
  RENTAL_EXPENSE_CATEGORIES,
  RentalAccountingError,
  voidRentalExpenseLinkTx,
} from "../server/services/rental/rentalExpenseAttributionService";

type Row = Record<string, unknown>;
const dialect = new PgDialect();

interface World {
  contract: Row[];
  previous: Row[];
  voucher: Row[];
  reversal: Row[];
  allocated: Row[];
  inserted: Row[];
  links: Row[];
  link: Row[];
}
let world: World;
let log: Array<{ text: string; params: unknown[] }>;
const tx = {
  execute: async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    log.push({ text, params });
    const pick = (): Row[] => {
      if (text.includes("FROM property_contracts")) return world.contract;
      if (text.includes("client_request_key=")) return world.previous;
      if (text.includes("AS posted_cost_usd")) return world.voucher;
      if (text.includes("reversal_of_voucher_id=") && text.includes("LIMIT 1")) return world.reversal;
      if (text.includes("AS total")) return world.allocated;
      if (text.includes("INSERT INTO accounting_rental_expense_links")) return world.inserted;
      if (text.includes("AS source_status")) return world.links;
      if (text.includes("NULL::text AS voucher_number")) return world.link;
      return [];
    };
    return { rows: pick() };
  },
} as never;
const actor = { userId: "u1", username: "landlord" };
const request = (over: Row = {}) =>
  ({
    companyId: 3,
    module: "properties",
    contractId: 20,
    voucherId: 30,
    category: "repairs",
    amountUsd: "40.5",
    note: "Roof",
    clientRequestKey: "req-0001",
    actor,
    ...over,
  }) as Parameters<typeof linkRentalExpenseTx>[1];

async function rentalError(work: Promise<unknown>) {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RentalAccountingError);
  const e = error as RentalAccountingError;
  return [e.code, e.message, e.status];
}

beforeEach(() => {
  log = [];
  world = {
    contract: [{ id: 20, unit_id: 5, module: "properties" }],
    previous: [],
    voucher: [
      {
        id: 30,
        company_id: 3,
        voucher_number: "JV-30",
        effective_on: "2026-10-20",
        posted_cost_usd: "100.000000",
        deleted_at: null,
        optional: false,
      },
    ],
    reversal: [],
    allocated: [{ total: "50" }],
    inserted: [{ id: 77 }],
    links: [{ id: 1 }],
    link: [{ id: 9, voided_at: null }],
  };
  h.scope.mockReset().mockResolvedValue(undefined);
  h.businessDate.mockReset().mockResolvedValue("2026-10-30");
  h.audit.mockReset().mockResolvedValue(undefined);
});

describe("linkRentalExpenseTx", () => {
  it("links a live expense voucher within its remaining capacity and audits it", async () => {
    expect(await linkRentalExpenseTx(tx, request())).toEqual({ id: 77, amountUsd: "40.500000", replayed: false });
    expect(h.scope).toHaveBeenCalledWith(tx, 3);
    const lock = log.find((q) => q.text.includes("pg_advisory_xact_lock"));
    expect(lock?.params).toEqual(["rental-voucher-allocation:3:30"]);
    expect(log.some((q) => q.text.includes("FOR UPDATE"))).toBe(true);
    expect(log.find((q) => q.text.includes("erp_assert_accounting_date_open"))?.params).toEqual([3, "2026-10-30"]);
    const insert = log.find((q) => q.text.includes("INSERT INTO"));
    expect(insert?.params).toEqual([3, "properties", 20, 5, 30, "repairs", "40.500000", "Roof", "u1", "req-0001"]);
    expect(h.audit).toHaveBeenCalledWith(
      {
        companyId: 3,
        userId: "u1",
        username: "landlord",
        action: "create",
        tableName: "accounting_rental_expense_links",
        recordId: 77,
        recordIdentifier: "property-expense:20:30",
        changes: {
          contractId: { new: 20 },
          voucherId: { new: 30 },
          category: { new: "repairs" },
          allocatedUsd: { new: "40.500000" },
          note: { new: "Roof" },
        },
      },
      tx
    );
  });

  it("allows exactly the remaining capacity, a missing total and no note", async () => {
    expect(await linkRentalExpenseTx(tx, request({ amountUsd: "50.000001" }))).toMatchObject({
      replayed: false,
    });
    world.allocated = [];
    expect(await linkRentalExpenseTx(tx, request({ amountUsd: "100", note: undefined }))).toMatchObject({ id: 77 });
    expect(log.filter((q) => q.text.includes("INSERT INTO")).at(-1)?.params[7]).toBeNull();
    expect(h.audit.mock.calls.at(-1)?.[0].changes.note).toEqual({ new: null });
  });

  it("refuses an allocation beyond the voucher's remaining expense", async () => {
    expect(await rentalError(linkRentalExpenseTx(tx, request({ amountUsd: "50.01" })))).toEqual([
      "RENTAL_OVERALLOCATION",
      "Expense allocation exceeds this voucher's available expense debit USD (50.000000 remaining)",
      409,
    ]);
    expect(log.some((q) => q.text.includes("INSERT INTO"))).toBe(false);
  });

  it("validates the request before touching the database", async () => {
    const cases: Array<[Row, string]> = [
      [{ voucherId: 0 }, "RENTAL_INVALID_ID"],
      [{ clientRequestKey: "short" }, "RENTAL_REQUEST_KEY_INVALID"],
      [{ clientRequestKey: "abcdefg" }, "RENTAL_REQUEST_KEY_INVALID"],
      [{ clientRequestKey: "has space1" }, "RENTAL_REQUEST_KEY_INVALID"],
      [{ clientRequestKey: "k".repeat(129) }, "RENTAL_REQUEST_KEY_INVALID"],
      [{ category: "rent" }, "RENTAL_CATEGORY_INVALID"],
      [{ amountUsd: "0" }, "RENTAL_AMOUNT_INVALID"],
      [{ amountUsd: "-1" }, "RENTAL_AMOUNT_INVALID"],
      [{ amountUsd: "1.0000001" }, "RENTAL_AMOUNT_INVALID"],
      [{ amountUsd: "100000000000000" }, "RENTAL_AMOUNT_INVALID"],
      [{ amountUsd: "Infinity" }, "RENTAL_AMOUNT_INVALID"],
      [{ note: "n".repeat(1001) }, "RENTAL_NOTE_TOO_LONG"],
      [{ companyId: -1 }, "RENTAL_INVALID_ID"],
      [{ contractId: 2.5 }, "RENTAL_INVALID_ID"],
    ];
    for (const [over, code] of cases) {
      const [actual, , status] = await rentalError(linkRentalExpenseTx(tx, request(over)));
      expect([actual, status]).toEqual([code, 400]);
    }
    expect(log).toEqual([]);
    expect(RENTAL_EXPENSE_CATEGORIES).toContain("property_tax");
  });

  it("refuses a contract outside the company and rental module", async () => {
    world.contract = [];
    expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
      "RENTAL_CONTRACT_NOT_FOUND",
      "This contract is not owned by your selected company and rental module",
      404,
    ]);
    expect(log[0].params).toEqual([20, 3, "properties"]);
  });

  it("replays a matching request ID and refuses a conflicting one", async () => {
    const previous = {
      id: 66,
      contract_id: 20,
      voucher_id: 30,
      module: "properties",
      category: "repairs",
      allocated_usd: "40.500000",
      note: "Roof",
      voided_at: null,
    };
    world.previous = [previous];
    expect(await linkRentalExpenseTx(tx, request())).toEqual({ id: 66, amountUsd: "40.500000", replayed: true });
    expect(log.some((q) => q.text.includes("AS posted_cost_usd"))).toBe(false);
    world.previous = [{ ...previous, note: null }];
    expect(await linkRentalExpenseTx(tx, request({ note: undefined }))).toMatchObject({ replayed: true });

    for (const over of [
      { voided_at: "2026-10-01" },
      { contract_id: 21 },
      { voucher_id: 31 },
      { module: "shop" },
      { category: "utilities" },
      { allocated_usd: "40.51" },
      { note: "Other" },
    ]) {
      world.previous = [{ ...previous, ...over }];
      expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
        "RENTAL_REQUEST_CONFLICT",
        "The request ID already belongs to a different or cancelled attribution",
        409,
      ]);
    }
  });

  it("requires a live posted voucher with expense debits that is not reversed or in the future", async () => {
    const voucher = world.voucher[0];
    for (const rows of [[], [{ ...voucher, deleted_at: "x" }], [{ ...voucher, optional: true }]]) {
      world.voucher = rows;
      expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
        "RENTAL_VOUCHER_UNPOSTED",
        "A live posted voucher from this company is required",
        400,
      ]);
    }
    for (const cost of ["0", "-5"]) {
      world.voucher = [{ ...voucher, posted_cost_usd: cost }];
      expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
        "RENTAL_VOUCHER_NOT_EXPENSE",
        "The source voucher has no positive expense account debit to allocate",
        400,
      ]);
    }
    world.voucher = [voucher];
    world.reversal = [{ id: 31 }];
    expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
      "RENTAL_VOUCHER_REVERSED",
      "A reversed expense voucher cannot receive new property expense allocations",
      409,
    ]);
    world.reversal = [];
    world.voucher = [{ ...voucher, effective_on: "2026-10-31" }];
    expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
      "RENTAL_VOUCHER_FUTURE",
      "An expense voucher dated in the future cannot be attributed as incurred",
      400,
    ]);
    world.voucher = [{ ...voucher, effective_on: "2026-10-30" }];
    await expect(linkRentalExpenseTx(tx, request())).resolves.toMatchObject({ id: 77 });
  });

  it("reports a link the database did not return", async () => {
    world.inserted = [];
    expect(await rentalError(linkRentalExpenseTx(tx, request()))).toEqual([
      "RENTAL_LINK_FAILED",
      "Property expense was not linked",
      409,
    ]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("listRentalExpenseLinksTx", () => {
  it("lists the contract's links as of a date after checking ownership", async () => {
    const input = { companyId: 3, module: "properties" as const, contractId: 20, asOfDate: "2026-10-15" };
    expect(await listRentalExpenseLinksTx(tx, input)).toEqual([{ id: 1 }]);
    const query = log.find((q) => q.text.includes("AS source_status"));
    expect(query?.params).toEqual([
      "2026-10-15",
      "2026-10-15",
      3,
      "properties",
      20,
      "2026-10-15",
      "2026-10-15",
      "2026-10-15",
    ]);
    expect(query?.text).toContain("LIMIT 500");
    world.contract = [];
    expect((await rentalError(listRentalExpenseLinksTx(tx, input)))[0]).toBe("RENTAL_CONTRACT_NOT_FOUND");
  });
});

describe("voidRentalExpenseLinkTx", () => {
  const voidLink = (over: Row = {}) =>
    voidRentalExpenseLinkTx(tx, { companyId: 3, linkId: 9, reason: "  Wrong unit ", actor, ...over } as never);

  it("voids an active link with a trimmed reason and audits it", async () => {
    expect(await voidLink()).toEqual({ linkId: 9, voided: true });
    expect(log.find((q) => q.text.includes("erp_assert_accounting_date_open"))?.params).toEqual([3, "2026-10-30"]);
    const update = log.find((q) => q.text.includes("UPDATE accounting_rental_expense_links"));
    expect(update?.params).toEqual(["u1", "Wrong unit", 3, 9]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "void",
        recordId: 9,
        recordIdentifier: "property-expense-link:9",
        changes: { voided: { old: false, new: true }, reason: { new: "Wrong unit" } },
      }),
      tx
    );
  });

  it("validates ids and the reason, and refuses missing or already-void links", async () => {
    for (const over of [{ companyId: 0 }, { linkId: -2 }]) {
      expect((await rentalError(voidLink(over)))[0]).toBe("RENTAL_INVALID_ID");
    }
    for (const reason of ["   ", "r".repeat(1001)]) {
      expect(await rentalError(voidLink({ reason }))).toEqual([
        "RENTAL_VOID_REASON",
        "Enter a reason (1 to 1,000 characters)",
        400,
      ]);
    }
    expect(log).toEqual([]);
    world.link = [];
    expect(await rentalError(voidLink())).toEqual(["RENTAL_LINK_NOT_FOUND", "Expense link not found", 404]);
    world.link = [{ id: 9, voided_at: "2026-10-01" }];
    expect(await rentalError(voidLink())).toEqual(["RENTAL_LINK_ALREADY_VOID", "Expense link already cancelled", 409]);
    expect(log.some((q) => q.text.includes("UPDATE accounting_rental_expense_links"))).toBe(false);
  });
});
