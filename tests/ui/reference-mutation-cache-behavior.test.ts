/**
 * After a successful reference-data write, applyReferenceMutationResponse
 * patches the cached lists and settings in place instead of refetching them:
 * a created row is inserted in name order, an edited row is merged, a deleted
 * row is removed (by the id in the URL when the answer has no body), paged
 * payloads keep their total, and unusable answers leave the cache alone.
 */
import { QueryClient } from "@tanstack/react-query";
import { applyReferenceMutationResponse, updateReferenceListPayload } from "@/lib/referenceMutationCache";

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status });

function apply(client: QueryClient, method: string, pathname: string, response: Response) {
  return applyReferenceMutationResponse({ client, method, pathname, response });
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
});

describe("reference list payloads", () => {
  it("inserts new rows in name order and merges edits", () => {
    const rows = [
      { id: 1, name: "Alpha" },
      { id: 3, code: "C10" },
    ];

    expect(updateReferenceListPayload(rows, { method: "POST", entity: { id: 2, name: "Beta" }, id: null })).toEqual([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
      { id: 3, code: "C10" },
    ]);
    expect(updateReferenceListPayload(rows, { method: "PATCH", entity: { id: 1, city: "X" }, id: 1 })).toEqual([
      { id: 1, name: "Alpha", city: "X" },
      { id: 3, code: "C10" },
    ]);
    expect(
      updateReferenceListPayload(["junk", { id: 9 }], { method: "PUT", entity: { id: 9, name: "N" }, id: 9 })
    ).toEqual(["junk", { id: 9, name: "N" }]);
  });

  it("ignores rows it cannot identify", () => {
    const rows = [{ id: 1 }];

    expect(updateReferenceListPayload(rows, { method: "POST", entity: "not a row", id: null })).toBe(rows);
    expect(updateReferenceListPayload(rows, { method: "POST", entity: { name: "No id" }, id: null })).toBe(rows);
    expect(updateReferenceListPayload(rows, { method: "DELETE", entity: null, id: null })).toBe(rows);
  });

  it("matches rows by any of the reference id fields", () => {
    const rows = [{ workerId: 4 }, { supplierId: 5 }, { customerId: 6 }, { employeeId: 7 }, { locationId: 8 }];

    expect(updateReferenceListPayload(rows, { method: "DELETE", entity: null, id: 6 })).toEqual([
      { workerId: 4 },
      { supplierId: 5 },
      { employeeId: 7 },
      { locationId: 8 },
    ]);
  });

  it("keeps paged payloads' totals in step and leaves other shapes alone", () => {
    const paged = { items: [{ id: 1 }, { id: 2 }], total: 2, page: 1 };

    expect(updateReferenceListPayload(paged, { method: "DELETE", entity: null, id: 2 })).toEqual({
      items: [{ id: 1 }],
      total: 1,
      page: 1,
    });
    expect(updateReferenceListPayload({ rows: [{ id: 1 }] }, { method: "POST", entity: { id: 5 }, id: 5 })).toEqual({
      rows: [{ id: 1 }, { id: 5 }],
    });
    expect(
      updateReferenceListPayload({ results: [{ id: 1 }], total: 1 }, { method: "PATCH", entity: { id: 1 }, id: 1 })
    ).toEqual({ results: [{ id: 1 }], total: 1 });
    expect(updateReferenceListPayload({ count: 3 }, { method: "DELETE", entity: null, id: 1 })).toEqual({ count: 3 });
    expect(updateReferenceListPayload("text", { method: "DELETE", entity: null, id: 1 })).toBe("text");
  });
});

describe("applyReferenceMutationResponse", () => {
  it("removes a deleted row by the id in the URL when the answer has no body", async () => {
    client.setQueryData(["/api/suppliers", 1], [{ id: 4 }, { id: 5 }]);

    await expect(apply(client, "delete", "/api/suppliers/5/", json(undefined, 204))).resolves.toBe(true);

    expect(client.getQueryData(["/api/suppliers", 1])).toEqual([{ id: 4 }]);
  });

  it("unwraps the entity from its named payload key", async () => {
    client.setQueryData(["/api/stock-groups", 1], { data: [{ id: 1, name: "B" }], total: 1 });

    await apply(client, "POST", "/api/stock-groups", json({ stockGroup: { id: 2, name: "A" } }, 201));

    expect(client.getQueryData(["/api/stock-groups", 1])).toEqual({
      data: [
        { id: 2, name: "A" },
        { id: 1, name: "B" },
      ],
      total: 2,
    });
  });

  it("merges settings objects and refuses settings answers that are not objects", async () => {
    client.setQueryData(["/api/company-settings", 1], { theme: "dark", locale: "en" });

    await expect(apply(client, "PUT", "/api/company-settings", json({ settings: { locale: "fr" } }))).resolves.toBe(
      true
    );
    expect(client.getQueryData(["/api/company-settings", 1])).toEqual({ theme: "dark", locale: "fr" });

    await expect(apply(client, "PUT", "/api/company-settings", json("not json"))).resolves.toBe(false);
    expect(client.getQueryData(["/api/company-settings", 1])).toEqual({ theme: "dark", locale: "fr" });
  });

  it("ignores reads, failures and unrelated writes", async () => {
    client.setQueryData(["/api/suppliers", 1], [{ id: 4 }]);

    await expect(apply(client, "GET", "/api/suppliers", json([]))).resolves.toBe(false);
    await expect(apply(client, "DELETE", "/api/suppliers/4", json({}, 500))).resolves.toBe(false);
    await expect(apply(client, "POST", "/api/unrelated", json({}))).resolves.toBe(false);
    expect(client.getQueryData(["/api/suppliers", 1])).toEqual([{ id: 4 }]);
  });

  it("refreshes the SP profit report after a voucher write and profiled lists after their writes", async () => {
    client.setQueryData(["/api/sp/report/profit?from=a", 1], {});
    client.setQueryData(["/api/ledger-accounts", 1], []);

    await expect(apply(client, "POST", "/api/vouchers", json({}))).resolves.toBe(true);
    await expect(apply(client, "PATCH", "/api/ledger-accounts/3", json({}))).resolves.toBe(true);

    expect(client.getQueryState(["/api/sp/report/profit?from=a", 1])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["/api/ledger-accounts", 1])?.isInvalidated).toBe(true);
  });

  it("resets the stock-transfer editor caches after a save that names its voucher", async () => {
    for (const key of [
      ["/api/stock-transfers", 12],
      ["/api/vouchers", 12],
    ]) {
      client.setQueryData(key, { stale: true });
    }

    await expect(
      apply(client, "PATCH", "/api/stock-transfers/3", json({ lifecycle: { voucherId: 12 } }))
    ).resolves.toBe(true);

    expect(client.getQueryData(["/api/stock-transfers", 12])).toBeUndefined();
    expect(client.getQueryData(["/api/vouchers", 12])).toBeUndefined();
  });

  it.each([
    ["no body", json("not json")],
    ["no voucher", json({ transfer: { id: 3 } })],
    ["a bad voucher id", json({ voucherId: -1 })],
  ])("leaves the stock-transfer caches alone for a save with %s", async (_label, response) => {
    client.setQueryData(["/api/stock-transfers", 12], { kept: true });

    await expect(apply(client, "PUT", "/api/stock-transfers/3", response)).resolves.toBe(false);

    expect(client.getQueryData(["/api/stock-transfers", 12])).toEqual({ kept: true });
  });
});
