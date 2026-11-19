/**
 * Pristine linked intercompany PO deletion against the real schema: every
 * refusal leaves both companies' POs, vouchers and the container untouched,
 * and the happy path removes the whole linked set atomically.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  daybookLinkedVoucherTrades,
  deletePristineLinkedTrade,
  deletionVoucherIds,
  findLinkedTradeForPo,
} from "../server/services/intercompany/linkedTradePhysicalDelete";

type Trade = Awaited<ReturnType<IntercompanyTradeWorld["trade"]>>;

async function world<T>(work: (w: IntercompanyTradeWorld, t: Trade) => Promise<T>) {
  return withRolledBackPool(async (client) => {
    const w = await createIntercompanyTradeWorld(client);
    const t = await w.trade();
    return work(w, t);
  });
}

async function intact(w: IntercompanyTradeWorld, t: Trade) {
  const [row] = await w.q<{ pos: number; vouchers: number; trades: number; containers: number }>(
    `SELECT (SELECT count(*)::int FROM purchase_orders WHERE id IN ($1, $2)) AS pos,
            (SELECT count(*)::int FROM vouchers WHERE id = ANY($3::int[]) AND deleted_at IS NULL) AS vouchers,
            (SELECT count(*)::int FROM intercompany_trades WHERE id = $4) AS trades,
            (SELECT count(*)::int FROM containers WHERE id = $5) AS containers`,
    [t.sourcePoId, t.destinationPoId, Object.values(t.vouchers), t.tradeId, t.containerId]
  );
  expect(row).toEqual({ pos: 2, vouchers: 4, trades: 1, containers: 1 });
}

async function refused(w: IntercompanyTradeWorld, t: Trade, code: string, version = 1, role = "Owner") {
  await expect(
    deletePristineLinkedTrade(t.tradeId, version, w.identity(w.sourceCompanyId, role))
  ).rejects.toMatchObject({ code });
  await intact(w, t);
}

describe("deletionVoucherIds", () => {
  it("keeps only positive safe integer voucher IDs from the import evidence", () => {
    expect(deletionVoucherIds(null)).toEqual([]);
    expect(deletionVoucherIds("text")).toEqual([]);
    expect(deletionVoucherIds({ originalSupplierVoucherIds: [1, -2], sourceSaleVoucherId: 3 })).toEqual([3]);
    expect(
      deletionVoucherIds({
        originalSupplierVoucherIds: [4, 5],
        sourceSaleVoucherId: 6,
        sourceCostVoucherId: "7",
        destinationVoucherId: 8,
      })
    ).toEqual([4, 5, 6, 8]);
  });
});

describe("linked trade lookups", () => {
  it("finds the trade from either its destination or its source PO, and nothing for unrelated POs", () =>
    world(async (w, t) => {
      expect(await findLinkedTradeForPo(t.destinationPoId)).toBe(t.tradeId);
      expect(await findLinkedTradeForPo(t.sourcePoId)).toBe(t.tradeId);
      expect(await findLinkedTradeForPo(-1)).toBeNull();
    }));

  it("rejects invalid Daybook selections", () =>
    world(async (w) => {
      for (const ids of [[], [0], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)]) {
        await expect(daybookLinkedVoucherTrades(ids, w.identity())).rejects.toMatchObject({
          code: "IC_DELETE_IDS",
          status: 422,
        });
      }
    }));

  it("maps only the original import vouchers of active trades with matching evidence", () =>
    world(async (w, t) => {
      await t.audit();
      const ids = [...Object.values(t.vouchers), 999999999];
      const fromSource = await daybookLinkedVoucherTrades(ids, w.identity());
      expect(Object.keys(fromSource).map(Number).sort()).toEqual(Object.values(t.vouchers).sort());
      expect(fromSource[t.vouchers.sale]).toEqual({ tradeId: t.tradeId, version: 1 });
      const fromDestination = await daybookLinkedVoucherTrades(ids, w.identity(w.destinationCompanyId));
      expect(fromDestination[t.vouchers.destinationPurchase]).toEqual({ tradeId: t.tradeId, version: 1 });

      // A second trade without evidence and one whose evidence names another container are ignored.
      const bare = await w.trade("B");
      const wrong = await w.trade("C");
      await wrong.audit({ physicalContainerId: t.containerId });
      const more = await daybookLinkedVoucherTrades(
        [...Object.values(bare.vouchers), ...Object.values(wrong.vouchers)],
        w.identity()
      );
      expect(more).toEqual({});
    }));

  it("returns nothing for a company without linked trades and refuses non-members", () =>
    world(async (w) => {
      const lonely = await w.company("X", "erp");
      const outsider = await w.otherUser([[lonely, "Owner"]]);
      expect(await daybookLinkedVoucherTrades([1], w.identity(lonely, "Owner", outsider))).toEqual({});
      await expect(
        daybookLinkedVoucherTrades([1], w.identity(w.sourceCompanyId, "Owner", outsider))
      ).rejects.toMatchObject({ code: "IC_EDIT_FORBIDDEN", status: 403 });
    }));
});

describe("deletePristineLinkedTrade refusals", () => {
  it("allows only Owners and Developers", () => world((w, t) => refused(w, t, "IC_DELETE_FORBIDDEN", 1, "Admin")));

  it("hides the trade from a company outside the pair", () =>
    world(async (w, t) => {
      const other = await w.company("Z", "erp");
      const owner = await w.otherUser([[other, "Owner"]]);
      await expect(deletePristineLinkedTrade(t.tradeId, 1, w.identity(other, "Owner", owner))).rejects.toMatchObject({
        code: "IC_EDIT_NOT_FOUND",
        status: 404,
      });
      await expect(deletePristineLinkedTrade(0, 1, w.identity())).rejects.toMatchObject({ code: "IC_EDIT_ID" });
      await intact(w, t);
    }));

  it("refuses a stale version", () => world((w, t) => refused(w, t, "IC_DELETE_STALE", 2)));

  it("refuses an offloaded container", () =>
    withRolledBackPool(async (client) => {
      const w = await createIntercompanyTradeWorld(client);
      const t = await w.trade("R", "Offloaded");
      await t.audit();
      await refused(w, t, "IC_EDIT_INVENTORY_DEPENDENCY");
    }));

  it("refuses when price revisions exist", () =>
    world(async (w, t) => {
      await t.audit();
      await w.q(
        `INSERT INTO intercompany_trade_revisions (trade_id, revision_number, kind, request_key, actor_user_id,
           initiating_company_id, amount_before, amount_after, posting_date, reason)
         VALUES ($1, 2, 'line_edit', $2, $3, $4, 100, 90, '2026-06-02', 'fixture')`,
        [t.tradeId, `${w.tag}-rev`, w.userId, w.sourceCompanyId]
      );
      await refused(w, t, "IC_DELETE_DEPENDENCY");
    }));

  it("refuses when the container carries an unrelated PO", () =>
    world(async (w, t) => {
      await t.audit();
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, supplier_id, po_number, items_total, currency, status)
         VALUES ($1, $2, $3, $4, 0, 'USD', 'Open')`,
        [w.sourceCompanyId, t.containerId, w.externalSupplierId, `${w.tag}-EXTRA`]
      );
      await refused(w, t, "IC_DELETE_EXTRA_PO");
    }));

  it("refuses when another intercompany record shares the container", () =>
    world(async (w, t) => {
      await t.audit();
      await w.q(
        `INSERT INTO intercompany_trades (relationship_id, physical_container_id, source_company_id, destination_company_id, state)
         VALUES ($1, $2, $3, $4, 'canceled')`,
        [w.relationshipId, t.containerId, w.sourceCompanyId, w.destinationCompanyId]
      );
      await refused(w, t, "IC_DELETE_OTHER_TRADE");
    }));

  it("refuses without complete import voucher evidence", () =>
    world(async (w, t) => {
      await refused(w, t, "IC_DELETE_VOUCHER_EVIDENCE");
      await t.audit({ destinationVoucherId: null });
      await refused(w, t, "IC_DELETE_VOUCHER_EVIDENCE");
    }));

  it("refuses duplicated voucher evidence", () =>
    world(async (w, t) => {
      await t.audit({ sourceCostVoucherId: t.vouchers.sale });
      await refused(w, t, "IC_DELETE_VOUCHER_EVIDENCE");
    }));

  it("refuses invalid historical normalization evidence", () =>
    world(async (w, t) => {
      await t.audit();
      await w.q(
        `INSERT INTO intercompany_audit_events (event_key, relationship_id, source_company_id, event_type, payload)
         VALUES ($1, $2, $3, 'technical-profit-normalized', '{"voucherId":"bad"}'::jsonb)`,
        [`ic-technical-profit-normalized:${t.tradeId}`, w.relationshipId, w.sourceCompanyId]
      );
      await refused(w, t, "IC_DELETE_NETTING_EVIDENCE");
    }));

  it("refuses when a voucher named by the evidence is missing or belongs to another company", () =>
    world(async (w, t) => {
      await t.audit();
      const stranger = await w.company("V", "erp");
      const foreign = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 0) RETURNING id`,
        [stranger, `${w.tag}-FOREIGN`]
      );
      await w.q(
        `INSERT INTO intercompany_audit_events (event_key, relationship_id, source_company_id, event_type, payload)
         VALUES ($1, $2, $3, 'technical-profit-normalized', $4::jsonb)`,
        [
          `ic-technical-profit-normalized:${t.tradeId}`,
          w.relationshipId,
          w.sourceCompanyId,
          JSON.stringify({ voucherId: foreign }),
        ]
      );
      await refused(w, t, "IC_DELETE_VOUCHER_STALE");
      const [{ n }] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM vouchers WHERE id = $1`, [foreign]);
      expect(n).toBe(1);
    }));
});

describe("deletePristineLinkedTrade success", () => {
  it("removes both POs, the import vouchers, the container and the batch, and records the audit event", () =>
    world(async (w, t) => {
      await t.audit();
      const result = await deletePristineLinkedTrade(t.tradeId, 1, w.identity(w.destinationCompanyId));
      expect(result).toMatchObject({ deleted: true, tradeId: t.tradeId, poIds: [t.sourcePoId, t.destinationPoId] });
      expect([...result.voucherIds].sort()).toEqual(Object.values(t.vouchers).sort());
      const [row] = await w.q(
        `SELECT (SELECT count(*)::int FROM purchase_orders WHERE container_id = $1) AS pos,
                (SELECT count(*)::int FROM vouchers WHERE id = ANY($2::int[])) AS vouchers,
                (SELECT count(*)::int FROM containers WHERE id = $1) AS containers,
                (SELECT count(*)::int FROM intercompany_import_batches WHERE id = $3) AS batches,
                (SELECT payload->>'noReversalVoucherCreated' FROM intercompany_audit_events
                  WHERE event_key = 'ic-linked-physical-delete:' || $4) AS audit`,
        [t.containerId, Object.values(t.vouchers), t.batchId, t.tradeId]
      );
      expect(row).toEqual({ pos: 0, vouchers: 0, containers: 0, batches: 0, audit: "true" });
    }));

  it("deletes a valid normalization voucher too and keeps a batch that still has other containers", () =>
    world(async (w, t) => {
      await t.audit();
      const normalization = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 0) RETURNING id`,
        [w.sourceCompanyId, `${w.tag}-NORM`]
      );
      await w.q(
        `INSERT INTO intercompany_audit_events (event_key, relationship_id, source_company_id, event_type, payload)
         VALUES ($1, $2, $3, 'technical-profit-normalized', $4::jsonb)`,
        [
          `ic-technical-profit-normalized:${t.tradeId}`,
          w.relationshipId,
          w.sourceCompanyId,
          JSON.stringify({ voucherId: normalization }),
        ]
      );
      await w.q(
        `INSERT INTO intercompany_import_batch_containers (batch_id, container_number, destination_company_id)
         VALUES ($1, $2, $3)`,
        [t.batchId, `${w.tag}-OTHER`, w.destinationCompanyId]
      );
      const result = await deletePristineLinkedTrade(t.tradeId, 1, w.identity(w.sourceCompanyId, "Developer"));
      expect(result.voucherIds).toContain(normalization);
      const [row] = await w.q(
        `SELECT (SELECT count(*)::int FROM vouchers WHERE id = $1) AS normalization,
                (SELECT count(*)::int FROM intercompany_import_batches WHERE id = $2) AS batches`,
        [normalization, t.batchId]
      );
      expect(row).toEqual({ normalization: 0, batches: 1 });
    }));
});
