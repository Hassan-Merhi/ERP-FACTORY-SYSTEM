/** Source-only Phase 2 regressions. Intentionally not executed by this task. */
import { describe, expect, it } from "vitest";
import {
  createDispatchTripFinancialSource,
  DispatchFinancialSourceError,
  type DispatchSourceInput,
} from "../server/services/factory/dispatchTripFinancialSource";

const source = (): DispatchSourceInput => ({
  companyId: 1,
  orderId: 101,
  dispatchId: 17,
  customerId: 9,
  closureHistoryId: "24",
  closureRevision: 2,
  manifestFingerprint: "a".repeat(64),
  manifest: [
    { scanId: "200", baleId: 42, baleReference: "BALE-42", articleCode: "A100", productName: "Shirts", weightKg: "12.500" },
    { scanId: "201", baleId: 43, baleReference: "BALE-43", articleCode: "A100", productName: "Shirts", weightKg: "13.250" },
  ],
  orderBales: [
    { baleId: 42, baleReference: "BALE-42", articleCode: "A100", productName: "Shirts", weightKg: "12.500", priceUsed: "0.10" },
    { baleId: 43, baleReference: "BALE-43", articleCode: "A100", productName: "Shirts", weightKg: "13.250", priceUsed: "0.20" },
    { baleId: 44, baleReference: "BALE-44", articleCode: "B200", productName: "Jeans", weightKg: "8.000", priceUsed: "9.00" },
  ],
  activeScans: [
    { scanId: "200", baleId: 42, dispatchId: "17" },
    { scanId: "201", baleId: 43, dispatchId: "17" },
  ],
});

const rejectWith = (input: DispatchSourceInput, code: string) => {
  try {
    createDispatchTripFinancialSource(input);
    throw new Error("Expected source validation to reject the changed evidence");
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchFinancialSourceError);
    expect((error as DispatchFinancialSourceError).code).toBe(code);
  }
};

describe("Phase 2 Factory Dispatch signed financial source", () => {
  it("uses exact signed bale IDs, not the full Pending Loading, with cents-precise totals", () => {
    const actual = createDispatchTripFinancialSource(source());
    expect(actual.baleCount).toBe(2);
    expect(actual.goodsSubtotal).toBe("0.30");
    expect(actual.totalWeightKg).toBe("25.750");
    expect(actual.bales.map((b) => b.baleId)).toEqual([42, 43]);
    expect(actual.bales[0].priceSource).toBe("ORDER_BALE_PRICE_USED");
    expect(actual.bales[0].articleCode).toBe("A100");
  });

  it("uses a deterministic fingerprint that changes if pricing or closure changes", () => {
    const first = createDispatchTripFinancialSource(source());
    expect(createDispatchTripFinancialSource(source()).sourceFingerprint).toBe(first.sourceFingerprint);
    const repriced = source();
    repriced.orderBales = repriced.orderBales.map((b) =>
      b.baleId === 43 ? { ...b, priceUsed: "0.25" } : b
    );
    expect(createDispatchTripFinancialSource(repriced).sourceFingerprint).not.toBe(first.sourceFingerprint);
    const revision = source();
    revision.closureRevision = 3;
    expect(createDispatchTripFinancialSource(revision).sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it("rejects older closures that did not preserve a bale-level manifest", () => {
    rejectWith({ ...source(), manifest: null }, "MANIFEST_UNAVAILABLE");
  });

  it("refuses duplicated physical barcodes in saved closure evidence", () => {
    const input = source();
    input.manifest = [...(input.manifest as object[]), (input.manifest as object[])[0]];
    rejectWith(input, "MANIFEST_INVALID");
  });

  it("refuses a scan removed or modified since physical closure", () => {
    const input = source();
    input.activeScans = input.activeScans.slice(1);
    rejectWith(input, "SCANS_CHANGED");
  });

  it("refuses bale replacements or price source inconsistencies", () => {
    const input = source();
    input.orderBales = input.orderBales.filter((b) => b.baleId !== 42);
    rejectWith(input, "LOADING_CHANGED");
  });

  it("refuses unknown article codes instead of exporting bale references", () => {
    const input = source();
    input.orderBales = input.orderBales.map((b) => b.baleId === 42 ? { ...b, articleCode: null } : b);
    rejectWith(input, "ARTICLE_CODE_MISSING");
  });

  it("refuses malformed monetary snapshots instead of treating invalid pricing as zero", () => {
    const input = source();
    input.orderBales = input.orderBales.map((b) => b.baleId === 42 ? { ...b, priceUsed: "abc" } : b);
    rejectWith(input, "PRICE_UNRESOLVED");
  });

  it("refuses changed bale weights", () => {
    const input = source();
    input.orderBales = input.orderBales.map((b) => b.baleId === 42 ? { ...b, weightKg: "11.500" } : b);
    rejectWith(input, "LOADING_CHANGED");
  });
});
