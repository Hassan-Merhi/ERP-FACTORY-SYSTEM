import { describe, expect, it, vi } from "vitest";
import {
  assertReprintMatchesPrepared,
  PRIORITY_PRINT_BATCH_LIMIT,
  preparePriorityPrintLabels,
  withRecordedPriorityAllocations,
} from "./priorityPrintPreflight";
import type { LabelData } from "./labelHtml";

const bale = (referenceNumber: string, priorityColor?: string): LabelData => ({
  referenceNumber,
  articleCode: "PANT-A",
  pieces: 1,
  approxWeightKg: "40",
  productName: "Adult Jogger Pant",
  ...(priorityColor ? { priorityColor, priorityOrderId: 77 } : {}),
});
const ok = (results: unknown) =>
  ({
    ok: true,
    json: async () => ({ results }),
  }) as Response;
const prepared = (id: number, reference: string, allocation: unknown) => ({
  baleId: id,
  referenceNumber: reference,
  priorityAllocation: allocation,
});

describe("Phase 5: priority print batch preflight", () => {
  it("uses the original saved color, loading and priority for an allocated reprint", async () => {
    const request = vi.fn(async () =>
      ok([
        prepared(101, "REF101", {
          baleId: 101,
          orderId: 77,
          referenceNumber: "REF101",
          priority: 1,
          color: "#dc2626",
          existing: true,
          source: "stock-entry",
        }),
      ])
    );
    const input = [bale("REF101")];
    const output = await preparePriorityPrintLabels(input, request, [101]);
    expect(output[0]).toMatchObject({
      referenceNumber: "REF101",
      priorityColor: "#dc2626",
      priorityOrderId: 77,
      priorityNumber: 1,
    });
    expect(input[0].priorityColor).toBeUndefined();
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch",
      { items: [{ baleId: 101 }] }
    );
  });

  it("prints normal labels if no priority needs that product", async () => {
    const request = vi.fn(async () => ok([prepared(202, "REF202", null)]));
    const output = await preparePriorityPrintLabels([bale("REF202")], request, [202]);
    expect(output[0].priorityColor).toBeUndefined();
    expect(output[0].priorityOrderId).toBeNull();
  });

  it("keeps mixed batches' individual colors and leaves unallocated labels normal", async () => {
    const request = vi.fn(async () =>
      ok([
        prepared(2, "B", null),
        prepared(3, "C", {
          baleId: 3,
          orderId: 90,
          referenceNumber: "C",
          priority: 2,
          color: "#2563eb",
          existing: true,
          source: "reprint",
        }),
        prepared(1, "A", {
          baleId: 1,
          orderId: 77,
          referenceNumber: "A",
          priority: 1,
          color: "#dc2626",
          existing: true,
          source: "stock-entry",
        }),
      ])
    );
    const outputs = await preparePriorityPrintLabels([bale("A"), bale("B"), bale("C")], request, [1, 2, 3]);
    expect(outputs.map((o) => o.priorityColor)).toEqual(["#dc2626", undefined, "#2563eb"]);
    expect(outputs.map((o) => o.priorityOrderId)).toEqual([77, null, 90]);
  });

  it("works with reference-only specialist relabel screens", async () => {
    const request = vi.fn(async () => ok([prepared(123, "NEW-REF", null)]));
    const output = await preparePriorityPrintLabels([bale("NEW-REF")], request);
    expect(output[0].referenceNumber).toBe("NEW-REF");
    expect(request).toHaveBeenCalledWith("POST", expect.any(String), { items: [{ referenceNumber: "NEW-REF" }] });
  });

  it("fails closed if the server rejects or omits part of a print batch", async () => {
    const reject = vi.fn(async () => ({ ok: false, json: async () => ({ message: "Bale not found" }) }) as Response);
    await expect(preparePriorityPrintLabels([bale("BAD")], reject)).rejects.toThrow("Bale not found");

    const incomplete = vi.fn(async () => ok([prepared(1, "A", null)]));
    await expect(preparePriorityPrintLabels([bale("A"), bale("B")], incomplete, [1, 2])).rejects.toThrow(
      "Priority preparation missing bale B"
    );
  });

  it("blocks a stale allocation rather than printing the wrong color", async () => {
    const request = vi.fn(async () => ok([prepared(1, "A", null)]));
    await expect(preparePriorityPrintLabels([bale("A", "#dc2626")], request, [1])).rejects.toThrow(
      "no longer allocated"
    );
    const changed = vi.fn(async () =>
      ok([
        prepared(1, "A", {
          baleId: 1,
          referenceNumber: "A",
          orderId: 200,
          priority: 1,
          color: "#16a34a",
          source: "reprint",
          existing: true,
        }),
      ])
    );
    await expect(preparePriorityPrintLabels([bale("A", "#dc2626")], changed, [1])).rejects.toThrow("Loading changed");
  });

  it("maps recorded print endpoint snapshots by physical bale ID, not result order", () => {
    const result = withRecordedPriorityAllocations(
      [bale("A"), bale("B")],
      [1, 2],
      [
        {
          baleId: 2,
          referenceNumber: "B",
          orderId: 5,
          color: "#dc2626",
          priority: 1,
          source: "stock-entry",
          existing: true,
        },
      ]
    );
    expect(result[0].priorityColor).toBeUndefined();
    expect(result[1]).toMatchObject({ priorityColor: "#dc2626", priorityOrderId: 5 });
  });

  it("deduplicated server rows can be mapped back to duplicate reference labels", async () => {
    const request = vi.fn(async () => ok([prepared(1, "A", null)]));
    const labels = await preparePriorityPrintLabels([bale("A"), bale("A")], request);
    expect(labels).toHaveLength(2);
    expect(labels.every((label) => !label.priorityColor)).toBe(true);
  });

  it("prints a fallback-code label by physical bale ID without a reference cross-check", async () => {
    // Bales without a stored reference print their bale code; the server
    // returns the stored (empty/different) reference for the same ID.
    const request = vi.fn(async () => ok([prepared(55, "", null)]));
    const output = await preparePriorityPrintLabels([bale("BALE-CODE-55")], request, [55]);
    expect(output[0].referenceNumber).toBe("BALE-CODE-55");
    expect(request).toHaveBeenCalledWith("POST", expect.any(String), { items: [{ baleId: 55 }] });
  });

  it("prepares large prints in server-sized atomic chunks and stops on the first failure", async () => {
    const labels = Array.from({ length: 450 }, (_, index) => bale(`R${index + 1}`));
    const ids = labels.map((_, index) => index + 1);
    const request = vi.fn(async (_method: string, _url: string, body?: unknown) => {
      const items = (body as { items: Array<{ baleId: number }> }).items;
      expect(items.length).toBeLessThanOrEqual(PRIORITY_PRINT_BATCH_LIMIT);
      return ok(items.map((item) => prepared(item.baleId, `R${item.baleId}`, null)));
    });
    const output = await preparePriorityPrintLabels(labels, request, ids);
    expect(output).toHaveLength(450);
    expect(request).toHaveBeenCalledTimes(3);

    const failing = vi
      .fn()
      .mockResolvedValueOnce(ok(ids.slice(0, 200).map((id) => prepared(id, `R${id}`, null))))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: "Bale not found" }) } as Response);
    await expect(preparePriorityPrintLabels(labels, failing, ids)).rejects.toThrow("Bale not found");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("reprint audit agreement", () => {
  const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

  it("accepts an audit that returns the same loading as the prepared label", async () => {
    await expect(
      assertReprintMatchesPrepared(response({ priorityAllocation: { orderId: 77 } }), bale("A", "#dc2626"))
    ).resolves.toBeUndefined();
    await expect(
      assertReprintMatchesPrepared(response({ priorityAllocation: null }), bale("B"))
    ).resolves.toBeUndefined();
  });

  it("refuses to print when the audit allocated a bale the label was prepared as ordinary", async () => {
    await expect(
      assertReprintMatchesPrepared(response({ priorityAllocation: { orderId: 90 } }), bale("B"))
    ).rejects.toThrow("Loading changed for B");
    await expect(assertReprintMatchesPrepared(response({}, false), bale("B"))).rejects.toThrow(
      "Could not record label reprint"
    );
  });
});
