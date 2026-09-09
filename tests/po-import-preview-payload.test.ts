/**
 * The PO-import `preview` payload boundary.
 *
 * `preview` is posted back from the import wizard on `req.body`, so it is
 * client-supplied and unvalidated. Both PO-import endpoints used to reach into
 * it through `any` and then cast the whole array to the shape they wanted, which
 * meant a payload that had drifted produced a `TypeError` partway through
 * writing purchase orders — a 500 after partial work — rather than a rejection.
 *
 * `findPreviewContainer` validates instead of casting. These pin what it accepts,
 * what it refuses, and that money fields arriving as numeric strings become
 * numbers rather than string-concatenating into the purchase-order totals.
 */
import { describe, expect, it } from "vitest";
import { findPreviewContainer } from "../server/routes/import/po-import-preview";

const item = {
  poNumber: "PO-1",
  barcode: "BC-1",
  itemName: "Sugar",
  quantity: 10,
  rate: 2.5,
  lineTotal: 25,
};

const container = {
  containerNumber: "MSKU1234567",
  items: [item],
  charges: { freight: 100, discount: 5 },
  itemsCount: 1,
  itemsTotal: 25,
  chargesTotal: 95,
  grandTotal: 120,
};

describe("findPreviewContainer", () => {
  it("returns the entry matching the requested container", () => {
    const other = { ...container, containerNumber: "OTHER0000001" };
    const found = findPreviewContainer([other, container], "MSKU1234567");

    expect(found?.containerNumber).toBe("MSKU1234567");
    expect(found?.items).toHaveLength(1);
    expect(found?.itemsTotal).toBe(25);
    expect(found?.grandTotal).toBe(120);
    expect(found?.charges).toEqual({ freight: 100, discount: 5 });
  });

  it("coerces money fields sent as numeric strings, so totals add rather than concatenate", () => {
    const found = findPreviewContainer(
      [
        {
          ...container,
          items: [{ ...item, quantity: "10", rate: "2.5", lineTotal: "25" }],
          itemsTotal: "25",
          chargesTotal: "95",
          grandTotal: "120",
        },
      ],
      "MSKU1234567"
    );

    expect(found?.items[0].lineTotal).toBe(25);
    expect(found?.items[0].quantity).toBe(10);
    expect(found?.items[0].rate).toBe(2.5);
    expect(found?.itemsTotal).toBe(25);
    expect(found?.grandTotal).toBe(120);

    // The sum the import handler computes over line totals.
    const summed = found!.items.reduce((sum, line) => sum + line.lineTotal, 0);
    expect(summed).toBe(25);
    expect(typeof summed).toBe("number");
  });

  it("returns null when the container is not in the payload", () => {
    expect(findPreviewContainer([container], "NOTTHERE0001")).toBeNull();
    expect(findPreviewContainer([], "MSKU1234567")).toBeNull();
  });

  it("returns null when the payload is not an array of entries", () => {
    expect(findPreviewContainer(undefined, "MSKU1234567")).toBeNull();
    expect(findPreviewContainer(null, "MSKU1234567")).toBeNull();
    expect(findPreviewContainer({ containerNumber: "MSKU1234567" }, "MSKU1234567")).toBeNull();
    expect(findPreviewContainer("MSKU1234567", "MSKU1234567")).toBeNull();
    expect(findPreviewContainer([null, 7, "x"], "MSKU1234567")).toBeNull();
  });

  it("returns null when the entry has no usable items array", () => {
    expect(findPreviewContainer([{ ...container, items: undefined }], "MSKU1234567")).toBeNull();
    expect(findPreviewContainer([{ ...container, items: "nope" }], "MSKU1234567")).toBeNull();
  });

  it("returns null when a line's money fields cannot be read", () => {
    for (const bad of [{ lineTotal: undefined }, { lineTotal: "abc" }, { quantity: null }, { rate: {} }]) {
      expect(findPreviewContainer([{ ...container, items: [{ ...item, ...bad }] }], "MSKU1234567")).toBeNull();
    }
  });

  it("returns null when a container total cannot be read, rather than writing NaN", () => {
    for (const key of ["itemsTotal", "chargesTotal", "grandTotal"]) {
      expect(findPreviewContainer([{ ...container, [key]: undefined }], "MSKU1234567")).toBeNull();
      expect(findPreviewContainer([{ ...container, [key]: "not-a-number" }], "MSKU1234567")).toBeNull();
    }
  });

  it("accepts an entry with no charges block, treating it as no charges", () => {
    const found = findPreviewContainer([{ ...container, charges: undefined }], "MSKU1234567");

    expect(found).not.toBeNull();
    expect(found?.charges).toEqual({});
  });

  it("keeps absent charges absent rather than defaulting them to zero", () => {
    const found = findPreviewContainer([{ ...container, charges: { freight: 100 } }], "MSKU1234567");

    expect(found?.charges).toEqual({ freight: 100 });
    expect(found?.charges.surcharge).toBeUndefined();
  });

  it("falls back to the line count when itemsCount is missing", () => {
    const found = findPreviewContainer(
      [{ ...container, items: [item, { ...item, barcode: "BC-2" }], itemsCount: undefined }],
      "MSKU1234567"
    );

    expect(found?.itemsCount).toBe(2);
  });

  it("normalises optional line strings and a missing stock item id", () => {
    const found = findPreviewContainer(
      [{ ...container, items: [{ quantity: 1, rate: 1, lineTotal: 1 }] }],
      "MSKU1234567"
    );

    expect(found?.items[0]).toMatchObject({
      poNumber: "",
      barcode: "",
      itemName: "",
      stockItemId: null,
    });
    expect(found?.items[0].currency).toBeUndefined();
  });
});
