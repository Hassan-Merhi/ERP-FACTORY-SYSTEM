/**
 * Frozen PO-export source of a posted truck trip (loadingDispatchPoExportData):
 * starting from a real posted trip, each piece of evidence is tampered with
 * inside the rolled-back transaction (cancelled order, un-posted financial,
 * revision without a snapshot, posting fingerprint drift, deleted voucher,
 * unlocked charge, a bale on two trips) and the loader must refuse with its
 * code. PO_MULTIPLE_EXPORTS is unreachable: factory_dispatch_trip_exports has a
 * unique index on financial_id. Immutable-row triggers are bypassed for the
 * tampering only, with session_replication_role inside the same transaction.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import {
  findTripPoExportTx,
  loadPostedTripPoSourceTx,
} from "../server/routes/factory/customer-orders/loadingDispatchPoExportData";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

type Tx = Parameters<typeof loadPostedTripPoSourceTx>[0];
const tx = db as unknown as Tx;

async function posted(w: FactoryWorld) {
  const { orderId, bales } = await loadingWithBales(w, ["100.00", "50.00"]);
  const { dispatchId } = await postedTrip(
    w,
    orderId,
    bales.map((b) => b.reference)
  );
  const scope = { companyId: w.companyId, orderId, dispatchId, userId: w.userId, username: w.username };
  const [fin] = await w.q(`SELECT id FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [dispatchId]);
  return { scope, financialId: Number(fin.id) };
}

/** Runs tampering statements with row triggers off, then turns them back on. */
async function tamper(w: FactoryWorld, statements: Array<[string, unknown[]]>) {
  await w.q(`SET LOCAL session_replication_role = replica`);
  try {
    for (const [text, params] of statements) await w.q(text, params);
  } finally {
    await w.q(`SET LOCAL session_replication_role = origin`).catch(() => undefined);
  }
}

const refusal = async (scope: Parameters<typeof loadPostedTripPoSourceTx>[1], lock = false) =>
  loadPostedTripPoSourceTx(tx, scope, lock).then(
    () => null,
    (error: { code?: string }) => error.code
  );

describe("posted trip PO source", () => {
  it("loads the frozen source with locks and reports no prior export", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      const source = await loadPostedTripPoSourceTx(tx, scope, true);
      expect(source).toMatchObject({ financialId, status: "POSTED", dispatchId: scope.dispatchId });
      expect(source.bales).toHaveLength(2);
      expect(await findTripPoExportTx(tx, scope, financialId)).toBeNull();
    });
  });

  it("refuses a cancelled order and an un-posted financial record", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      await tamper(w, [[`UPDATE factory_dispatch_trip_financials SET status = 'DRAFT' WHERE id = $1`, [financialId]]]);
      expect(await refusal(scope)).toBe("PO_TRIP_NOT_FINANCIALLY_POSTED");
      await tamper(w, [[`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [scope.orderId]]]);
      expect(await refusal(scope)).toBe("PO_ORDER_UNAVAILABLE");
    });
  });

  it("refuses a posted revision without matching frozen evidence", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      await tamper(w, [
        [
          `UPDATE factory_dispatch_trip_financials SET snapshot_revision = posting_revision + 1 WHERE id = $1`,
          [financialId],
        ],
      ]);
      expect(await refusal(scope)).toBe("PO_SNAPSHOT_MISMATCH");
    });
  });

  it("refuses a posting whose fingerprint drifted or whose voucher was deleted", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      const [posting] = await w.q(
        `SELECT id, voucher_ids FROM factory_dispatch_trip_postings WHERE financial_id = $1 AND kind = 'POST'`,
        [financialId]
      );
      const voucherIds = (posting.voucher_ids as number[]).map(Number);
      expect(voucherIds.length).toBeGreaterThan(0);
      await tamper(w, [[`UPDATE vouchers SET deleted_at = NOW() WHERE id = $1`, [voucherIds[0]]]]);
      expect(await refusal(scope)).toBe("PO_POSTED_VOUCHER_MISSING");
      await tamper(w, [
        [`UPDATE factory_dispatch_trip_postings SET source_fingerprint = 'drift' WHERE id = $1`, [posting.id]],
      ]);
      expect(await refusal(scope)).toBe("PO_POSTING_UNVERIFIED");
    });
  });

  it("refuses unlocked charges and a bale allocated to two posted trips", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      const [account] = await w.q(`SELECT id FROM ledger_accounts WHERE company_id = $1 LIMIT 1`, [w.companyId]);
      const [fin] = await w.q(`SELECT posting_revision FROM factory_dispatch_trip_financials WHERE id = $1`, [
        financialId,
      ]);
      await tamper(w, [
        [
          `INSERT INTO factory_dispatch_trip_charges (company_id, order_id, dispatch_id, financial_id, revision, name, kind, amount, currency, ledger_account_id)
           VALUES ($1, $2, $3, $4, $5, 'Late fee', 'BILLABLE', 5, 'USD', $6)`,
          [w.companyId, scope.orderId, scope.dispatchId, financialId, fin.posting_revision, account.id],
        ],
      ]);
      expect(await refusal(scope)).toBe("PO_CHARGES_NOT_FROZEN");
      await tamper(w, [
        [`UPDATE factory_dispatch_trip_charges SET locked_at = NOW() WHERE financial_id = $1`, [financialId]],
      ]);
      expect((await loadPostedTripPoSourceTx(tx, scope)).charges.map((c) => c.name)).toContain("Late fee");

      // A second posted trip of the same order that froze one of these bales.
      const otherDispatch = await w.one(
        `INSERT INTO factory_loading_dispatches (company_id, order_id, dispatch_number, created_by_user_id, created_by_username, status)
         SELECT company_id, order_id, dispatch_number + 100, created_by_user_id, created_by_username, 'CLOSED'
           FROM factory_loading_dispatches WHERE id = $1 RETURNING id`,
        [scope.dispatchId]
      );
      await tamper(w, [
        [
          `INSERT INTO factory_dispatch_trip_financials (company_id, order_id, dispatch_id, status, posting_revision, snapshot_revision,
             source_fingerprint, manifest_fingerprint, closure_history_id, posted_at, currency)
           SELECT company_id, order_id, $2, status, posting_revision, snapshot_revision,
             source_fingerprint, manifest_fingerprint, closure_history_id, posted_at, currency
             FROM factory_dispatch_trip_financials WHERE id = $1`,
          [financialId, otherDispatch],
        ],
        [
          `INSERT INTO factory_dispatch_trip_financial_bales (company_id, order_id, dispatch_id, financial_id, snapshot_revision, bale_id, bale_reference, closure_history_id, source_scan_id, article_code, product_name, price_source, unit_price, weight_kg, line_total)
           SELECT b.company_id, b.order_id, $2, f2.id, b.snapshot_revision, b.bale_id, b.bale_reference, b.closure_history_id, b.source_scan_id, b.article_code, b.product_name, b.price_source, b.unit_price, b.weight_kg, b.line_total
             FROM factory_dispatch_trip_financial_bales b
             JOIN factory_dispatch_trip_financials f2 ON f2.dispatch_id = $2
            WHERE b.financial_id = $1 LIMIT 1`,
          [financialId, otherDispatch],
        ],
      ]);
      expect(await refusal(scope)).toBe("PO_OVERLAPPING_TRIP_BALES");
    });
  });

  it("returns the single prior export (a second one is refused by the unique index)", async () => {
    await withFactoryWorld(async (w) => {
      const { scope, financialId } = await posted(w);
      await tamper(w, [
        [
          `INSERT INTO factory_dispatch_trip_exports (company_id, order_id, dispatch_id, financial_id, snapshot_revision, source_fingerprint, export_fingerprint, supplier_code, po_number, erp_container_number, exported_by_user_id, preview)
           VALUES ($1, $2, $3, $4, 1, 'src', 'exp', 'SUP', 'PO-1', $5, $6, '[1]'::jsonb)`,
          [w.companyId, scope.orderId, scope.dispatchId, financialId, `${w.tag}CNT`, w.userId],
        ],
      ]);
      const prior = await findTripPoExportTx(tx, scope, financialId);
      expect(prior).toMatchObject({ poNumber: "PO-1", supplierCode: "SUP", revision: 1, preview: {} });
    });
  });
});
