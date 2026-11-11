import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { summarizeCanonicalStockTransferNetEvidence } from "../server/services/inventory/canonicalStockTransferEvidence";
import { loadDatabaseCanonicalStockTransferEvidence } from "../server/services/inventory/databaseCanonicalStockTransferEvidence";
import {
  loadDatabaseStockTransferDocuments,
  mergeStockTransferConvergenceEvidence,
} from "../server/services/inventory/databaseStockTransferConvergenceAdapter";
import {
  reconcileConvergenceTx,
  type StockConvergenceSnapshot,
} from "../server/services/accounting/convergenceReconciliation";

const dialect = new PgDialect();
const document = {
  sourceType: "stock-transfer" as const,
  sourceId: "866",
  transferId: 866,
  voucherId: 15358,
  destinationLocationId: 2,
  companyId: 9,
  inventoryApplied: false,
  documentQuantity: "102",
  documentValue: "10509.98",
};

function postedEvidenceRows() {
  return [
    {
      companyId: 9,
      sourceType: "stock-transfer",
      sourceId: "866",
      stockItemId: 55,
      locationId: 1,
      destinationLocationId: 2,
      idempotencyKey: "stock-transfer-import-multi:15358:55",
      quantityDelta: "-102",
      unitCost: "103.03901960784313725490",
    },
    {
      companyId: 9,
      sourceType: "stock-transfer",
      sourceId: "866",
      stockItemId: 55,
      locationId: 2,
      destinationLocationId: 2,
      idempotencyKey: "stock-transfer-import-multi:15358:55",
      quantityDelta: "102",
      unitCost: "103.03901960784313725490",
    },
  ];
}

describe("ERP Phase 4 canonical transfer import and edit convergence", () => {
  it("includes posted transfer documents with false applied flags in the reconciliation input", async () => {
    let whereStatement = "";
    const selection: Record<string, unknown> = {};
    for (const stage of ["from", "innerJoin", "leftJoin", "groupBy"]) {
      selection[stage] = () => selection;
    }
    selection.where = (condition: { getSQL: () => never }) => {
      whereStatement = dialect.sqlToQuery(condition.getSQL()).sql;
      return selection;
    };
    selection.then = (resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve([
        {
          transferId: 866,
          voucherId: 15358,
          companyId: 9,
          sourceLocationId: 3,
          destinationLocationId: 4,
          inventoryApplied: false,
          itemCount: 58,
          documentQuantity: "102",
          documentValue: "10509.98",
        },
      ]).then(resolve);
    const tx = {
      execute: async () => ({ rows: [{ startedAt: "2026-08-15T00:00:00Z" }] }),
      select: () => selection,
    } as never;
    const documents = await loadDatabaseStockTransferDocuments({ tx, companyId: 9 });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      sourceId: "866",
      inventoryApplied: false,
      documentQuantity: "102",
    });
    expect(whereStatement).not.toContain("inventory_applied");
  });

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
    expect(query.sql).toContain("WITH requested(transfer_id, voucher_id, destination_location_id)");
    expect(query.sql).toContain("stock-transfer-import-multi-source");
    expect(query.sql).toContain("stock-transfer-import'");
    expect(query.sql).toContain("voucher_stock_transfer_edit_reverse");
    expect(query.sql).toContain("voucher_stock_transfer_edit_apply");
    expect(query.sql).toContain("movement.source_id = requested.transfer_id");
    expect(query.sql).toContain("movement.source_id = requested.voucher_id");
    expect(query.params).toEqual(expect.arrayContaining(["866", "15358", 2, 9]));
  });

  it("reads every historical edit and delta revision as a signed destination movement", async () => {
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
    expect(queries[0]).toContain("requested(transfer_id, voucher_id, destination_location_id)");
    expect(queries[0]).toContain('movement.location_id AS "locationId"');
    expect(queries[0]).not.toContain("max(revision)");
    expect(queries[0]).not.toContain("candidate.revision");
  });

  it("nets complete edits and delta revisions at the destination, never counting reversal receipts twice", () => {
    const batch = (key: string, quantity: number, from: number, to: number) => [
      {
        companyId: 9,
        sourceType: "stock-transfer",
        sourceId: "866",
        stockItemId: 55,
        locationId: from,
        destinationLocationId: 2,
        idempotencyKey: key,
        quantityDelta: String(-quantity),
        unitCost: "2.50",
      },
      {
        companyId: 9,
        sourceType: "stock-transfer",
        sourceId: "866",
        stockItemId: 55,
        locationId: to,
        destinationLocationId: 2,
        idempotencyKey: key,
        quantityDelta: String(quantity),
        unitCost: "2.50",
      },
    ];
    const [evidence] = summarizeCanonicalStockTransferNetEvidence({
      companyId: 9,
      rows: [
        // A prior destination may be completely absent from the current
        // document; its issue/reversal pair must still be validated.
        ...batch("old-dest:issue", 7, 1, 3),
        ...batch("old-dest:reverse", 7, 3, 1),
        ...batch("rev0:issue", 10, 1, 2),
        ...batch("rev1:issue", 2, 1, 2),
        ...batch("rev2:reverse", 3, 2, 1),
        ...batch("rev3:reverse", 9, 2, 1),
        ...batch("rev3:issue", 4, 1, 2),
      ],
    });
    expect(evidence).toMatchObject({
      sourceId: "866",
      movementQuantity: "4",
      movementValue: "10",
    });
  });

  it("rejects unbalanced or malformed two-leg batches instead of inventing net transfer evidence", () => {
    const [first, second] = postedEvidenceRows();
    expect(() =>
      summarizeCanonicalStockTransferNetEvidence({
        companyId: 9,
        rows: [first],
      })
    ).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED" }));
    expect(() =>
      summarizeCanonicalStockTransferNetEvidence({
        companyId: 9,
        rows: [first, { ...second, stockItemId: 56 }],
      })
    ).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED" }));
    expect(() =>
      summarizeCanonicalStockTransferNetEvidence({
        companyId: 9,
        rows: [first, { ...second, quantityDelta: "99" }],
      })
    ).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED" }));
    // Even an OLD-destination batch contributes zero to current stock only
    // after its two movement legs are independently proved to balance.
    expect(() =>
      summarizeCanonicalStockTransferNetEvidence({
        companyId: 9,
        rows: [
          { ...first, locationId: 3 },
          { ...second, locationId: 4, quantityDelta: "100" },
        ],
      })
    ).toThrowError(expect.objectContaining({ code: "CONVERGENCE_STOCK_EVIDENCE_UNBALANCED" }));
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
    const report = await reconcileConvergenceTx({ execute: async () => ({ rows: [] }) }, 9, {
      loadAccountingSnapshots: async () => [],
      loadStockSnapshots: async () => [documentSnapshot],
    });
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
    const report = await reconcileConvergenceTx({ execute: async () => ({ rows: [] }) }, 9, {
      loadAccountingSnapshots: async () => [],
      loadStockSnapshots: async () => [
        {
          sourceType: "stock-transfer",
          sourceId: "901",
          companyId: 9,
          inventoryApplied: true,
          documentQuantity: "2",
          movementQuantity: "2",
          documentValue: "50",
          movementValue: "50",
        },
      ],
    });
    expect(report.clean).toBe(true);
    expect(report.discrepancies).toEqual([]);
  });
});
