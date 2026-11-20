/**
 * Approving immutable stock transfer revisions
 * (server/services/approveImmutableStockTransferRevision.ts) directly, in a
 * rolled-back factory world with a posted Yard -> Shop transfer: reviewer and
 * id validation, unknown / other-company / deleted / non-pending revisions,
 * revisions without items, stale revisions, merging several pending
 * revisions (newest wins, the overridden one is superseded), new lines,
 * lines removed, already-approved no-ops, and the source / destination stock
 * guards.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { revisionWorld, transferQuantities, type RevisionWorld } from "./helpers/stockTransferRevisionWorld";
import { approveImmutableStockTransferRevision } from "../server/services/approveImmutableStockTransferRevision";

type Item = { stockItemId: number; original: number; next: number; source?: number };

let revisionSeq = 100;
async function pending(w: FactoryWorld, transferId: number, items: Item[], status = "pending") {
  const revisionId = await w.one(
    `INSERT INTO stock_transfer_revisions (transfer_id, revision_number, status, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [transferId, ++revisionSeq, status, w.userId]
  );
  for (const item of items) {
    await w.q(
      `INSERT INTO stock_transfer_revision_items (revision_id, stock_item_id, stock_item_name, source_location_id,
         original_quantity, new_quantity, delta)
       VALUES ($1, $2, 'Item', $3, $4, $5, $6)`,
      [revisionId, item.stockItemId, item.source ?? w.locationId, item.original, item.next, item.next - item.original]
    );
  }
  return revisionId;
}

const approve = (w: FactoryWorld, revisionId: number, companyId = w.companyId) =>
  approveImmutableStockTransferRevision(companyId, revisionId, w.userId);
const failure = (work: Promise<unknown>) =>
  work.then(
    () => "approved",
    (error: Error & { code?: string }) => error.code ?? error.message
  );

const inWorld = (work: (w: FactoryWorld, r: RevisionWorld) => Promise<void>) =>
  withFactoryWorld(async (w) => work(w, await revisionWorld(w)));

describe("approval refusals", () => {
  it("validates the reviewer and ids, and refuses unknown, foreign, deleted and closed revisions", () =>
    inWorld(async (w, r) => {
      expect(await failure(approveImmutableStockTransferRevision(w.companyId, 1, "  "))).toBe(
        "Reviewer ID is required"
      );
      expect(await failure(approveImmutableStockTransferRevision(w.companyId, 0, w.userId))).toMatch(/Revision ID/);
      expect(await failure(approve(w, 2_000_000_000))).toBe("Revision not found");

      const foreign = await pending(w, r.foreignTransferId, [
        { stockItemId: r.foreignItem, original: 0, next: 1, source: r.foreignLocation },
      ]);
      expect(await failure(approve(w, foreign))).toBe("STOCK_TRANSFER_REVISION_SCOPE");

      const rejected = await pending(w, r.transferId, [{ stockItemId: r.itemA, original: 4, next: 5 }], "rejected");
      expect(await failure(approve(w, rejected))).toBe("STOCK_TRANSFER_REVISION_STATUS");

      const empty = await pending(w, r.transferId, []);
      expect(await failure(approve(w, empty))).toBe("Pending revision has no items");

      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [r.voucherId]);
      expect(await failure(approve(w, empty))).toBe("Deleted stock transfers cannot be revised");
    }));

  it("refuses stale revisions and moves that the stock cannot cover", () =>
    inWorld(async (w, r) => {
      const stale = await pending(w, r.transferId, [{ stockItemId: r.itemA, original: 3, next: 5 }]);
      expect(await failure(approve(w, stale))).toBe("STOCK_TRANSFER_REVISION_STALE");
      await w.q(`UPDATE stock_transfer_revisions SET status = 'rejected' WHERE id = $1`, [stale]);

      const tooMuch = await pending(w, r.transferId, [{ stockItemId: r.itemA, original: 4, next: 40 }]);
      expect(await failure(approve(w, tooMuch))).toBe("STOCK_TRANSFER_INSUFFICIENT_STOCK");
      await w.q(`UPDATE stock_transfer_revisions SET status = 'rejected' WHERE id = $1`, [tooMuch]);

      await w.q(`UPDATE inventory SET quantity = 0 WHERE location_id = $1 AND stock_item_id = $2`, [r.shop, r.itemB]);
      const shrink = await pending(w, r.transferId, [{ stockItemId: r.itemB, original: 2, next: 1 }]);
      expect(await failure(approve(w, shrink))).toBe("STOCK_TRANSFER_DESTINATION_STOCK_CONFLICT");
      expect(await transferQuantities(w, r.transferId)).toEqual([4, 2]);
    }));
});

describe("approval merges", () => {
  it("lets the newest pending revision win a shared line, adds new lines and removes zeroed ones", () =>
    inWorld(async (w, r) => {
      const extra = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Bale C', 'PCS', true) RETURNING id`,
        [w.companyId, `${w.tag}C`]
      );
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 5, 3, 15)`,
        [w.companyId, w.locationId, extra]
      );
      const older = await pending(w, r.transferId, [{ stockItemId: r.itemA, original: 4, next: 6 }]);
      const newer = await pending(w, r.transferId, [
        { stockItemId: r.itemA, original: 4, next: 5 },
        { stockItemId: r.itemB, original: 2, next: 0 },
        { stockItemId: extra, original: 0, next: 1 },
      ]);
      // A newer pending revision from the same submitter supersedes the older one.
      expect(await failure(approve(w, older))).toBe("STOCK_TRANSFER_REVISION_STATUS");
      const result = await approve(w, newer);
      expect(result).toMatchObject({ transferId: r.transferId });
      const rows = await w.q<{ stock_item_id: number; q: string; rate: string }>(
        `SELECT stock_item_id, quantity::text AS q, rate::text AS rate FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY stock_item_id`,
        [r.transferId]
      );
      expect(rows.map((row) => [Number(row.stock_item_id), Number(row.q)])).toEqual([
        [r.itemA, 5],
        [extra, 1],
      ]);
      expect(Number(rows[1].rate)).toBe(3);
      const statuses = await w.q<{ id: number; status: string }>(
        `SELECT id, status FROM stock_transfer_revisions WHERE id = ANY($1::int[]) ORDER BY id`,
        [[older, newer]]
      );
      expect(statuses.map((s) => s.status)).toEqual(["superseded", "approved"]);

      const again = await approve(w, newer);
      expect(again).toMatchObject({ transition: "no-op", changedItemCount: 0 });
    }));
});
