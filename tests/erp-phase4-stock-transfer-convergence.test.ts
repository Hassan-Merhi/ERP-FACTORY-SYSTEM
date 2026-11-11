import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { loadDatabaseCanonicalStockTransferEvidence } from "../server/services/inventory/databaseCanonicalStockTransferEvidence";
import { mergeStockTransferConvergenceEvidence } from "../server/services/inventory/databaseStockTransferConvergenceAdapter";
import { reconcileConvergenceTx, type StockConvergenceSnapshot } from "../server/services/accounting/convergenceReconciliation";

const dialect = new PgDialect();
const document = {
  sourceType: "stock-transfer" as const,
  sourceId: "866",
  transferId: 866,
  voucherId: 15358,
  companyId: 9,
  inventoryApplied: false,
  documentQuantity: "102",
  documentValue: "10509.98",
};

function postedEvidenceRows() {
  return [
    { companyId: 9, sourceType: "stock-transfer", sourceId: "866", quantityDelta: "-102", unitCost: "103.03901960784313725490" },
    { companyId: 9, sourceType: "stock-transfer", sourceId: "866", quantityDelta: "102", unitCost: "103.03901960784313725490" },
  ];
}

describe("ERP Phase 4 canonical transfer import and edit convergence", () => {
  it("queries normal transfers by transfer ID and both import formats by voucher ID", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      execute: async (statement: never) => {
        queries.push(dialect.sqlToQuery(statement));
        return { rows: postedEvidenceRows() };
      },
    } as never;

    const evidence = await loadDatabaseCanonicalStockTransferEvidence({
      tx,
      companyId: 9,
      documents: [document],
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceId).toBe("866");
    expect(evidence[0].movementQuantity).toBe("102");
    const query = queries[0];
    expect(query.sql).toContain("WITH requested(transfer_id, voucher_id)");
    expect(query.sql).toContain("stock-transfer-import-multi-source");
    expect(query.sql).toContain("stock-transfer-import'");
    expect(query.sql).toContain("movement.source_id = requested.transfer_id");
    expect(query.sql).toContain("movement.source_id = requested.voucher_id");
    expect(query.params).toEqual(expect.arrayContaining(["866", "15358", 9]));
  });

  it("selects the latest revision's ISSUE movements, excluding history and reverse legs", async () => {
    const queries: string[] = [];
    await loadDatabaseCanonicalStockTransferEvidence({
      tx: {
        execute: async (statement: never) => {
          queries.push(dialect.sqlToQuery(statement).sql);
          return { rows: postedEvidenceRows() };
        },
      } as never,
      companyId: 9,
      documents: [document],
    });
    expect(queries[0]).toContain("max(revision) AS revision");
    expect(queries[0]).toContain("candidate.revision = latest.revision");
    expect(queries[0]).toContain("candidate.idempotency_key ~ (':issue:[0-9]+$')");
    expect(queries[0]).toContain("latest.revision IS NULL AND candidate.revision IS NULL");
  });

  it("rejects post-journal transfer documents lacking canonical evidence", () => {
    expect(() =>
      mergeStockTransferConvergenceEvidence({
        companyId: 9,
        documents: [document],
        evidence: [],
      })
    ).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_MISSING" }));
  });

  it("reports a stale unapplied flag even when transfer quantity and value match", async () => {
    const documentSnapshot: StockConvergenceSnapshot = {
      sourceType: "stock-transfer",
      sourceId: "866",
      companyId: 9,
      inventoryApplied: false,
      documentQuantity: "102",
      movementQuantity: "102",
      documentValue: "10509.98",
      movementValue: "10509.98",
    };
    const report = await reconcileConvergenceTx(
      { execute: async () => ({ rows: [] }) },
      9,
      {
        loadAccountingSnapshots: async () => [],
        loadStockSnapshots: async () => [documentSnapshot],
      }
    );
    expect(report.clean).toBe(false);
    expect(report.discrepancies).toContainEqual({
      domain: "inventory",
      identity: "stock-transfer:866",
      code: "STOCK_TRANSFER_APPLIED_FLAG_MISMATCH",
      expected: "true",
      actual: "false",
    });
  });

  it("does not mislabel an ordinary applied transfer when its flag is true", async () => {
    const report = await reconcileConvergenceTx(
      { execute: async () => ({ rows: [] }) },
      9,
      {
        loadAccountingSnapshots: async () => [],
        loadStockSnapshots: async () => [{
          sourceType: "stock-transfer",
          sourceId: "901",
          companyId: 9,
          inventoryApplied: true,
          documentQuantity: "2",
          movementQuantity: "2",
          documentValue: "50",
          movementValue: "50",
        }],
      }
    );
    expect(report.clean).toBe(true);
    expect(report.discrepancies).toEqual([]);
  });
});
