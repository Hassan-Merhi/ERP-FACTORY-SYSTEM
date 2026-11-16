import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { assertTransferNotAlreadyPostedTx } from "../server/services/inventory/transferCanonicalAlreadyPostedGuard";

const dialect = new PgDialect();
const input = { companyId: 9, transferId: 866, voucherId: 15358 };

function transaction(hasOpenMovement: unknown) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [{ hasOpenMovement }] }),
  };
}

describe("ERP Phase 4 fail-closed transfer repost guard", () => {
  it("refuses an unapplied transfer if its own canonical movements still carry stock", async () => {
    const tx = transaction(true);
    await expect(assertTransferNotAlreadyPostedTx(tx as never, input)).rejects.toThrow(
      "STOCK_TRANSFER_ALREADY_APPLIED_CANONICAL"
    );
    expect(tx.execute).toHaveBeenCalledOnce();
    const statement = dialect.sqlToQuery(tx.execute.mock.calls[0][0]);
    expect(statement.sql).toContain("GROUP BY movement.stock_item_id, movement.location_id");
    expect(statement.sql).toContain("HAVING SUM(movement.quantity_delta) <> 0");
    expect(statement.sql).toContain("stock-transfer-import-multi-source");
    expect(statement.sql).toContain("voucher_stock_transfer_edit_reverse");
    expect(statement.params).toEqual(expect.arrayContaining([9, "866", "15358"]));
  });

  it("permits a fully reversed transfer whose net position is zero at every item/location", async () => {
    const tx = transaction(false);
    await expect(assertTransferNotAlreadyPostedTx(tx, input)).resolves.toBeUndefined();
  });

  it("fails closed when the database does not prove a false outstanding-movement result", async () => {
    for (const value of [undefined, null, "false", 1]) {
      await expect(assertTransferNotAlreadyPostedTx(transaction(value) as never, input)).rejects.toThrow(
        "STOCK_TRANSFER_CANONICAL_EVIDENCE_UNVERIFIED"
      );
    }
  });

  it("refuses malformed company, transfer and voucher identities", async () => {
    await expect(
      assertTransferNotAlreadyPostedTx(transaction(false) as never, { ...input, companyId: 0 })
    ).rejects.toThrow("STOCK_TRANSFER_POST_IDENTITY_INVALID");
  });

  it("protects BOTH draft-to-post and finalize flows before applying inventory", () => {
    const code = readFileSync(new URL("../server/services/stockTransferLifecycle.ts", import.meta.url), "utf8");
    const save = code.slice(code.indexOf("export async function saveStockTransferLifecycleTx"));
    const finalize = code.slice(code.indexOf("export async function finalizeOptionalStockTransferTx"));
    expect(save).toContain("if (!wasApplied && !willBeOptional)");
    expect(save.indexOf("assertTransferNotAlreadyPostedTx")).toBeLessThan(save.indexOf("validateAndApplyItems"));
    expect(finalize.indexOf("assertTransferNotAlreadyPostedTx")).toBeLessThan(
      finalize.indexOf("validateAndApplyItems")
    );
  });
});
