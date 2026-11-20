/**
 * Route audit helpers: action normalisation for customer-order status edits,
 * actor fallback, insert failure propagation, voucher snapshot name fallbacks
 * and the create/delete/update/item-level change builders.
 *
 * logAudit and snapshotVoucherEntries take their database handle as an
 * argument, so a recording handle stands in for the database here; the
 * insert payload and lookup behaviour are what the callers depend on.
 */
import { describe, expect, it } from "vitest";

import {
  buildItemLevelChanges,
  buildVoucherChangesForCreate,
  buildVoucherChangesForDelete,
  buildVoucherChangesForUpdate,
  logAudit,
  snapshotVoucherEntries,
} from "../server/routes/helpers/auditHelpers";
import { runWithAuditActor } from "../server/services/audit/auditActorContext";
import type { DatabaseOrTransaction } from "../server/db";

function recordingConn(fail?: Error) {
  const inserted: Record<string, unknown>[] = [];
  const conn = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (fail) throw fail;
        inserted.push(row);
      },
    }),
  };
  return { inserted, conn: conn as unknown as Parameters<typeof logAudit>[1] & object };
}

const base = { userId: "u1", username: "alice", companyId: 5, tableName: "factory_customer_orders", recordId: 9 };

describe("logAudit", () => {
  it.each([
    [{ status: { old: "LOADING", new: "cancelled" } }, "cancel"],
    [{ status: { old: "cancelled", new: "loading" } }, "restore"],
    [{ status: { old: "LOADING", new: "DISPATCHED" } }, "update"],
    [{ notes: { old: "a", new: "b" } }, "update"],
    [null, "update"],
  ])("normalises a customer order update with %j to %s", async (changes, action) => {
    const { inserted, conn } = recordingConn();
    await logAudit({ ...base, action: "update", changes }, conn);
    expect(inserted[0]).toMatchObject({ action, userId: "u1", username: "alice", companyId: 5 });
  });

  it("keeps the action for other tables and other actions", async () => {
    const { inserted, conn } = recordingConn();
    const cancelled = { status: { old: "LOADING", new: "CANCELLED" } };
    await logAudit({ ...base, tableName: "vouchers", action: "update", changes: cancelled }, conn);
    await logAudit({ ...base, action: "delete", changes: cancelled }, conn);
    expect(inserted.map((row) => row.action)).toEqual(["update", "delete"]);
  });

  it("uses the request actor when the caller passes an empty or unknown user", async () => {
    const { inserted, conn } = recordingConn();
    await runWithAuditActor({ actorId: "actor-7", actorName: "bob" }, async () => {
      await logAudit({ ...base, userId: "", username: "", action: "create" }, conn);
      await logAudit({ ...base, userId: "unknown", username: "unknown", action: "create" }, conn);
    });
    await logAudit({ ...base, userId: "   ", username: "x", action: "create" }, conn);
    expect(inserted.map((row) => [row.userId, row.username])).toEqual([
      ["actor-7", "bob"],
      ["actor-7", "bob"],
      ["unknown", "unknown"],
    ]);
  });

  it("rethrows an insert failure so the caller's transaction rolls back", async () => {
    const { conn } = recordingConn(new Error("audit insert failed"));
    await expect(logAudit({ ...base, action: "create" }, conn)).rejects.toThrow("audit insert failed");
  });
});

/** A reader whose every lookup resolves to the rows queued for it, in call order. */
function fakeReader(results: Array<Array<Record<string, unknown>>>) {
  let calls = 0;
  const reader = {
    select: () => ({ from: () => ({ where: async () => results[calls++] ?? [] }) }),
  };
  return { reader: reader as unknown as DatabaseOrTransaction, calls: () => calls };
}

describe("snapshotVoucherEntries", () => {
  it("resolves each party kind by name and uses the account priority order", async () => {
    const { reader, calls } = fakeReader([
      [{ id: 1, name: "Cash" }],
      [{ id: 2, name: "Main Bank" }],
      [{ id: 3, name: "Supplier Ltd" }],
      [{ id: 4, firstName: "Ann", lastName: "" }],
      [{ id: 5, name: "Customer Co" }],
      [{ id: 6, name: "Factory Supplier" }],
    ]);
    const snaps = await snapshotVoucherEntries(
      [
        { ledgerAccountId: 1, bankAccountId: 2, debitAmount: "10", narration: "first" },
        { bankAccountId: 2, creditAmount: "10" },
        { supplierId: 3 },
        { employeeId: 4 },
        { customerId: 5 },
        { factorySupplierId: 6 },
        { debitAmount: null, creditAmount: null },
      ],
      reader
    );
    expect(calls()).toBe(6);
    expect(snaps).toEqual([
      { account: "Cash", debit: "10", credit: "0", narration: "first" },
      { account: "Main Bank", debit: "0", credit: "10" },
      { account: "Supplier Ltd", debit: "0", credit: "0" },
      { account: "Ann", debit: "0", credit: "0" },
      { account: "Customer Co", debit: "0", credit: "0" },
      { account: "Factory Supplier", debit: "0", credit: "0" },
      { account: "—", debit: "0", credit: "0" },
    ]);
  });

  it("falls back to a numbered label when a referenced row is not found", async () => {
    const { reader } = fakeReader([]);
    const snaps = await snapshotVoucherEntries(
      [
        { ledgerAccountId: 11 },
        { bankAccountId: 12 },
        { supplierId: 13 },
        { employeeId: 14 },
        { customerId: 15 },
        { factorySupplierId: 16 },
      ],
      reader
    );
    expect(snaps.map((snap) => snap.account)).toEqual([
      "Account #11",
      "Bank #12",
      "Supplier #13",
      "Employee #14",
      "Customer #15",
      "Supplier #16",
    ]);
  });

  it("does not query when there are no references", async () => {
    const { reader, calls } = fakeReader([]);
    expect(await snapshotVoucherEntries([], reader)).toEqual([]);
    expect(calls()).toBe(0);
  });
});

describe("voucher change builders", () => {
  const full = {
    voucherType: "Payment",
    voucherDate: "2026-01-02",
    totalAmount: "10.00",
    description: "rent",
    locationName: "Yard",
    locationId: 3,
  };
  const entries = [{ account: "Cash", debit: "10", credit: "0" }];

  it("create and delete record every present field", () => {
    expect(buildVoucherChangesForCreate(full, entries)).toEqual({
      voucherType: { new: "Payment" },
      date: { new: "2026-01-02" },
      amount: { new: "10.00" },
      description: { new: "rent" },
      location: { new: "Yard" },
      entries: { new: entries },
    });
    expect(buildVoucherChangesForDelete({ ...full, locationName: null }, entries)).toMatchObject({
      location: { old: "Location #3" },
      entries: { old: entries },
    });
  });

  it("create and delete skip absent fields and empty entries", () => {
    expect(buildVoucherChangesForCreate({}, [])).toEqual({});
    expect(buildVoucherChangesForDelete({}, [])).toEqual({});
    expect(buildVoucherChangesForCreate({ locationId: 4 }, [])).toEqual({ location: { new: "Location #4" } });
  });

  it("update reports only the fields that changed", () => {
    const changed = buildVoucherChangesForUpdate(
      { ...full, optional: false },
      {
        voucherType: "Receipt",
        voucherDate: "2026-01-03",
        totalAmount: "12",
        description: null,
        locationId: null,
        optional: true,
      },
      entries,
      []
    );
    expect(changed).toEqual({
      voucherType: { old: "Payment", new: "Receipt" },
      date: { old: "2026-01-02", new: "2026-01-03" },
      amount: { old: "10.00", new: "12" },
      description: { old: "rent", new: "" },
      location: { old: "Yard", new: null },
      optional: { old: false, new: true },
      entries: { old: entries, new: [] },
    });
  });

  it("update treats equal amounts and blank descriptions as unchanged and labels bare location ids", () => {
    const changed = buildVoucherChangesForUpdate(
      { totalAmount: "10.00", description: null, locationId: null },
      { totalAmount: "10", description: "", locationId: 8 },
      entries,
      [...entries]
    );
    expect(changed).toEqual({ location: { old: null, new: "Location #8" } });
  });
});

describe("buildItemLevelChanges", () => {
  it("describes added, removed and changed lines, resolving names once", async () => {
    const lookups: number[] = [];
    const changes = await buildItemLevelChanges(
      [
        { stockItemId: 1, quantity: "2", rate: "5", totalAmount: "10" },
        { stockItemId: 2, itemName: "Old", quantity: 1, rate: 1, lineTotal: 1 },
        { stockItemId: null, quantity: 9 },
      ],
      [
        { stockItemId: 1, quantity: "3", rate: "6" },
        { stockItemId: 3, quantity: null, rate: null, totalValue: 4 },
        { stockItemId: 4, itemName: "Named" },
      ],
      async (id) => {
        lookups.push(id);
        return `Resolved ${id}`;
      }
    );
    expect(changes).toEqual({
      item_added_1: { new: "Added Resolved 3, quantity , unit price , total 4" },
      item_added_2: { new: "Added Named, quantity , unit price , total " },
      item_removed_3: { old: "Removed Old, quantity 1, rate 1, total 1" },
      item_changed_4: { new: "Resolved 1: quantity from 2 to 3; unit price from 5 to 6" },
    });
    expect(lookups).toEqual([3, 1]);
  });

  it("uses an Item # label without a resolver and skips unchanged or unparsable lines", async () => {
    const changes = await buildItemLevelChanges(
      [
        { stockItemId: 1, quantity: "2", rate: "5" },
        { stockItemId: 2, quantity: "abc", rate: "1" },
        { stockItemId: 5, quantity: "1", rate: "1" },
      ],
      [
        { stockItemId: 1, quantity: "2.00001", rate: "5" },
        { stockItemId: 2, quantity: "4", rate: "zzz" },
        { stockItemId: 5, quantity: "1", rate: "2" },
      ]
    );
    expect(changes).toEqual({ item_changed_1: { new: "Item #5: unit price from 1 to 2" } });
  });

  it("names a line with stock item id 0 as Unknown Item", async () => {
    const changes = await buildItemLevelChanges([], [{ stockItemId: 0, quantity: 1, rate: 1, totalAmount: 1 }]);
    expect(changes).toEqual({ item_added_1: { new: "Added Unknown Item, quantity 1, unit price 1, total 1" } });
  });
});
