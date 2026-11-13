import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  finalizedStockItemId,
  planDestinationStockMapping,
  verifiedStockRowKey,
  type IncomingStockLine,
  type StockAliasIdentity,
  type StockIdentity,
} from "../server/services/intercompany/destinationStockMapping";

const source = (overrides: Partial<StockIdentity> = {}): StockIdentity => ({
  id: 11,
  companyId: 1,
  code: "BAL-001",
  name: "Cotton Grade A",
  uom: "KG",
  active: true,
  deletedAt: null,
  ...overrides,
});
const item = (id: number, overrides: Partial<StockIdentity> = {}): StockIdentity => ({
  ...source({ id, companyId: 2 }),
  ...overrides,
});
const row = (overrides: Partial<IncomingStockLine> = {}): IncomingStockLine => ({
  containerNumber: "TEST-CONT-001",
  destinationCompanyId: 2,
  rowNum: 12,
  barcode: "BAL-001",
  itemName: "Cotton Grade A",
  ...overrides,
});
const plan = (
  options: {
    items?: StockIdentity[];
    aliases?: StockAliasIdentity[];
    lines?: IncomingStockLine[];
    allowedDestinationIds?: number[];
  } = {}
) =>
  planDestinationStockMapping({
    sourceCompanyId: 1,
    items: options.items ?? [source()],
    aliases: options.aliases ?? [],
    lines: options.lines ?? [row()],
    allowedDestinationIds: options.allowedDestinationIds ?? [2],
  });

describe("Phase 4 verified destination stock mapping", () => {
  it("plans missing destination items from existing Properties stock, not unknown workbook fields", () => {
    const result = plan();
    expect(result.creations).toEqual([
      {
        key: "2:11",
        sourceItemId: 11,
        companyId: 2,
        code: "BAL-001",
        name: "Cotton Grade A",
        uom: "KG",
      },
    ]);
    expect(result.assignments[0]).toMatchObject({
      sourceItemId: 11,
      destinationItemId: null,
      creationKey: "2:11",
      destinationCompanyId: 2,
    });
    expect(result.reusedCount).toBe(0);
    expect(finalizedStockItemId(result.assignments[0], new Map([["2:11", 550]]))).toBe(550);
    expect(() => finalizedStockItemId(result.assignments[0], new Map())).toThrow("missing");
  });

  it("reuses a destination record when code, name and unit are verified", () => {
    const result = plan({ items: [source(), item(22)] });
    expect(result.creations).toHaveLength(0);
    expect(result.reusedCount).toBe(1);
    expect(result.assignments[0].destinationItemId).toBe(22);
    expect(finalizedStockItemId(result.assignments[0], new Map())).toBe(22);
  });

  it("reuses an exact normalized name with a different destination code", () => {
    const result = plan({ items: [source(), item(22, { code: "HADI-COTTON-A", name: "Cotton  Grade-A" })] });
    expect(result.creations).toHaveLength(0);
    expect(result.assignments[0].destinationItemId).toBe(22);
  });

  it("reuses only a matching alias when destination code differs", () => {
    const result = plan({
      items: [source(), item(22, { code: "HADI-A" })],
      aliases: [{ companyId: 2, stockItemId: 22, aliasCode: "BAL-001" }],
    });
    expect(result.assignments[0].destinationItemId).toBe(22);
    expect(result.creations).toHaveLength(0);
  });

  it("uses the source stock barcode even when its workbook name is absent", () => {
    const result = plan({ lines: [row({ itemName: "" })] });
    expect(result.assignments[0].sourceItemId).toBe(11);
    expect(result.creations[0].name).toBe("Cotton Grade A");
  });

  it("deduplicates one creation across multiple containers without merging the purchase rows", () => {
    const result = plan({
      lines: [row(), row({ containerNumber: "TEST-CONT-002", rowNum: 18 })],
    });
    expect(result.assignments).toHaveLength(2);
    expect(result.creations).toHaveLength(1);
    expect(result.assignments[0].creationKey).toBe(result.assignments[1].creationKey);
    expect(result.assignments[0].key).not.toBe(result.assignments[1].key);
  });

  it("creates separate master records for the same source item in different ERP companies", () => {
    const result = plan({
      allowedDestinationIds: [2, 3],
      lines: [row(), row({ containerNumber: "TEST-CONT-002", destinationCompanyId: 3, rowNum: 18 })],
    });
    expect(result.creations.map((entry) => entry.key)).toEqual(["2:11", "3:11"]);
  });

  it("fails closed for missing or ambiguous source identities", () => {
    expect(() => plan({ items: [], lines: [row({ barcode: "NOT-FOUND", itemName: "Unknown" })] })).toThrow(
      "Properties stock item"
    );
    const otherSource = source({ id: 12, code: "BAL-002" });
    expect(() =>
      plan({ items: [source(), otherSource], lines: [row({ barcode: "", itemName: "Cotton Grade A" })] })
    ).toThrow("multiple items");
    expect(() => plan({ lines: [row({ itemName: "Different Cotton" })] })).toThrow("conflicts");
  });

  it("rejects destination code collisions rather than silently relinking an unrelated item", () => {
    expect(() => plan({ items: [source(), item(22, { name: "Rubber Grade C" })] })).toThrow("conflicts");
  });

  it("rejects conflicting destination aliases and names even if one direct code matches", () => {
    expect(() =>
      plan({
        items: [source(), item(22), item(23, { code: "OTHER", name: "Rubber" })],
        aliases: [{ companyId: 2, stockItemId: 23, aliasCode: "BAL-001" }],
      })
    ).toThrow(/multiple items/);
    // A unique exact code is authoritative, even when another article has
    // the same display name. This occurs with SP.059 and TS.020 in test ERP.
    const sameNameDifferentCode = plan({
      items: [source(), item(22), item(23, { code: "OTHER" })],
    });
    expect(sameNameDifferentCode.assignments[0].destinationItemId).toBe(22);
  });

  it("matches SP.059 instead of TS.020 when both companies have duplicate article names", () => {
    const propertiesSp = source({ id: 9757, companyId: 22, code: "SP.059", name: "AJ M SPORT T-SHIRT (40kg)", uom: "BL" });
    const propertiesTs = source({ id: 9756, companyId: 22, code: "TS.020", name: "AJ M SPORT T-SHIRT (40kg)", uom: "BL" });
    const erpSp = source({ id: 10153, companyId: 24, code: "SP.059", name: "AJ M SPORT T-SHIRT (40kg)", uom: "BL" });
    const erpTs = source({ id: 10152, companyId: 24, code: "TS.020", name: "AJ M SPORT T-SHIRT (40kg)", uom: "BL" });
    const result = planDestinationStockMapping({
      sourceCompanyId: 22,
      items: [propertiesSp, propertiesTs, erpSp, erpTs],
      aliases: [],
      allowedDestinationIds: [24],
      lines: [{ containerNumber: "MRSU4976363", destinationCompanyId: 24, rowNum: 67, barcode: "SP.059", itemName: propertiesSp.name }],
    });
    expect(result.assignments[0]).toMatchObject({ sourceItemId: 9757, destinationItemId: 10153 });
    expect(result.creations).toHaveLength(0);
  });

  it("rejects a name-only lookup when the destination name remains ambiguous", () => {
    expect(() => plan({
      items: [source(), item(22, { code: "DEST-A" }), item(23, { code: "DEST-B" })],
    })).toThrow(/multiple items/);
  });

  it("rejects a destination unit mismatch before any creation is planned", () => {
    expect(() => plan({ items: [source(), item(22, { uom: "Bale" })] })).toThrow("Stock unit mismatch");
  });

  it("refuses inactive and deleted source or destination items", () => {
    expect(() => plan({ items: [source({ active: false })] })).toThrow("inactive or deleted");
    expect(() => plan({ items: [source(), item(22, { deletedAt: new Date("2026-01-01") })] })).toThrow(
      "inactive or deleted"
    );
    expect(() => plan({ items: [source(), item(22, { active: false })] })).toThrow("inactive or deleted");
  });

  it("does not allow cross-company alias pointers", () => {
    expect(() => plan({ aliases: [{ companyId: 2, stockItemId: 11, aliasCode: "COTTON-A" }] })).toThrow("conflicts");
  });

  it("refuses any unauthorized target company or duplicated workbook row", () => {
    expect(() => plan({ lines: [row({ destinationCompanyId: 99 })] })).toThrow("invalid");
    expect(() => plan({ lines: [row(), row()] })).toThrow("Duplicate");
    expect(() => verifiedStockRowKey("", 0)).toThrow("Duplicate");
  });

  it("rejects batch-local case-colliding codes before creating any destination items", () => {
    expect(() =>
      plan({
        items: [source(), source({ id: 12, code: "bal-001", name: "Cotton Grade B" })],
        lines: [row(), row({ rowNum: 13, barcode: "bal-001", itemName: "Cotton Grade B" })],
      })
    ).toThrow();
  });

  it("rejects batch-local duplicate names with distinct source codes", () => {
    expect(() =>
      plan({
        items: [source(), source({ id: 12, code: "BAL-002" })],
        lines: [row(), row({ rowNum: 13, barcode: "BAL-002" })],
      })
    ).toThrow(/conflicts/);
  });

  it("preserves the all-or-nothing posting boundary and zero opening balances", () => {
    const sourceCode = readFileSync("server/services/intercompany/containerTradingImport.ts", "utf8");
    expect(sourceCode).toContain("planDestinationStockMapping({");
    expect(sourceCode).toMatch(/tx\s*\.insert\(stockItems\)/);
    expect(sourceCode).toContain('openingQty: "0"');
    expect(sourceCode).toContain('openingValue: "0"');
    expect(sourceCode).toContain('sellingPrice: "0"');
    expect(sourceCode).toContain("postErpVoucherTx(tx");
    expect(sourceCode).toContain("destinationItemAutoCreated");
    expect(sourceCode).toContain("await logAudit(");
    expect(sourceCode).toContain("autoCreatedDestinationStockItemIds:");
  });
});
