import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  loadDatabaseCanonicalStockAdjustmentEvidence,
  mergeStockAdjustmentConvergenceEvidence,
  type StockAdjustmentDocumentSnapshot,
} from "../server/services/inventory/databaseStockAdjustmentConvergenceAdapter";

const document: StockAdjustmentDocumentSnapshot = {
  sourceType: "stock-adjustment",
  sourceId: "251",
  adjustmentId: 251,
  voucherId: 12886,
  companyId: 1,
  documentQuantity: "34",
  documentValue: "4461.04",
};

describe("ERP stock-adjustment edit lifecycle reconciliation", () => {
  it("queries the last edit-apply batch using voucher ID but returns adjustment ID", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const tx = {
      execute: async (statement: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        queries.push(new PgDialect().sqlToQuery(statement));
        return {
          rows: [{
            sourceId: "251",
            companyId: 1,
            movementQuantity: "34.000000",
            movementValue: "4461.040000",
          }],
        };
      },
    };
    const evidence = await loadDatabaseCanonicalStockAdjustmentEvidence({
      tx: tx as never,
      companyId: 1,
      documents: [document],
    });
    expect(evidence).toEqual([{
      sourceType: "stock-adjustment",
      sourceId: "251",
      companyId: 1,
      movementQuantity: "34.000000",
      movementValue: "4461.040000",
    }]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("max(e.created_at)");
    expect(queries[0].sql).toContain("stock_adjustment_edit_apply");
    expect(queries[0].sql).toContain("m.created_at = r.last_apply_at");
    expect(queries[0].sql).toContain("stock_adjustment_edit_reverse");
    expect(queries[0].sql).toContain("WHERE EXISTS");
    expect(queries[0].params).toContain("251");
    expect(queries[0].params).toContain("12886");
  });

  it("fails closed when original evidence is missing instead of allowing an edited document to look clean", () => {
    expect(() => mergeStockAdjustmentConvergenceEvidence({
      companyId: 1,
      documents: [document],
      evidence: [],
    })).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_MISSING" }));
  });

  it("keeps mismatched inventory movement values visible to the convergence engine", () => {
    const [snapshot] = mergeStockAdjustmentConvergenceEvidence({
      companyId: 1,
      documents: [document],
      evidence: [{
        sourceType: "stock-adjustment",
        sourceId: "251",
        companyId: 1,
        movementQuantity: "35",
        movementValue: "4555.24",
      }],
    });
    expect(snapshot.documentQuantity).toBe("34");
    expect(snapshot.movementQuantity).toBe("35");
    expect(snapshot.documentValue).toBe("4461.04");
    expect(snapshot.movementValue).toBe("4555.24");
  });
});
