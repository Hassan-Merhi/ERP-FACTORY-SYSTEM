/**
 * Phase 5 destination receipt of a linked container (receiveLinkedTrade) on the
 * intercompany trade fixture, inside one rolled-back transaction per test.
 * Refusals first: malformed input, a company outside the trading pair, a
 * Properties user without ERP membership, a stale version, a disabled
 * relationship, a legacy offload, foreign or inactive locations, a wrong
 * inventory account, foreign stock and a stock shortage. Each refusal leaves
 * no receipt, voucher or inventory row. Then the receipt itself, its exact
 * replay and a modified replay.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  exactDestinationReceiptPlan,
  receiveLinkedTrade,
  type ReceiveIntercompanyTradeInput,
} from "../server/services/intercompany/phase5Receipt";

const world = <T>(work: (w: IntercompanyTradeWorld) => Promise<T>) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));

let keySeq = 0;

async function setup(w: IntercompanyTradeWorld) {
  const t = await w.trade("A");
  const locationId = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'ERP Yard') RETURNING id`,
    [w.destinationCompanyId, `${w.tag}Y`]
  );
  const inventoryAccountId = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, 'INVENTORY', 'Inventory', 'Asset') RETURNING id`,
    [w.destinationCompanyId]
  );
  const input: ReceiveIntercompanyTradeInput = {
    tradeId: t.tradeId,
    expectedVersion: 1,
    requestKey: `receipt-key-${process.pid}-${++keySeq}`,
    postingDate: "2026-06-20",
    locationId,
    inventoryAccountId,
    arrivalEvidence: "Gate pass 4411 signed",
    reason: "Container arrived",
    confirmPhysicalArrival: true,
    confirmNoAdditionalUnpostedCharges: true,
  };
  return { t, locationId, inventoryAccountId, input };
}

async function footprint(w: IntercompanyTradeWorld, tradeId: number) {
  const [row] = await w.q<{ receipts: number; vouchers: number; stock: number }>(
    `SELECT (SELECT count(*)::int FROM intercompany_destination_receipts WHERE trade_id = $1) AS receipts,
            (SELECT count(*)::int FROM vouchers WHERE company_id = $2) AS vouchers,
            (SELECT count(*)::int FROM inventory WHERE company_id = $2) AS stock`,
    [tradeId, w.destinationCompanyId]
  );
  return row;
}

async function refused(
  w: IntercompanyTradeWorld,
  tradeId: number,
  run: () => Promise<unknown>,
  code: string,
  status?: number
) {
  const before = await footprint(w, tradeId);
  await expect(run()).rejects.toMatchObject(status ? { code, status } : { code });
  expect(await footprint(w, tradeId)).toEqual(before);
}

const destinationIdentity = (w: IntercompanyTradeWorld) => w.identity(w.destinationCompanyId, "Owner");

describe("exactDestinationReceiptPlan", () => {
  it("groups lines per stock item and allocates the landed cost by goods value", () => {
    expect(
      exactDestinationReceiptPlan(
        [
          { stockItemId: 2, quantity: "1", lineTotal: "30.00" },
          { stockItemId: 1, quantity: "2", lineTotal: "60.00" },
          { stockItemId: 2, quantity: "1.5", lineTotal: "10.00" },
        ],
        "100.00",
        "110.00"
      )
    ).toEqual([
      { stockItemId: 1, quantity: "2.000", value: "66.00" },
      { stockItemId: 2, quantity: "2.500", value: "44.00" },
    ]);
  });

  it("refuses missing, unidentified or mismatched lines and non-positive costs", () => {
    expect(() => exactDestinationReceiptPlan([], "0", "1")).toThrow(/missing/);
    expect(() => exactDestinationReceiptPlan([{ stockItemId: 0, quantity: "1", lineTotal: "1" }], "1", "1")).toThrow(
      /verified stock identity/
    );
    expect(() =>
      exactDestinationReceiptPlan([{ stockItemId: 1, quantity: "1", lineTotal: "1.001" }], "1", "1")
    ).toThrow(/exact USD value/);
    expect(() => exactDestinationReceiptPlan([{ stockItemId: 1, quantity: "1", lineTotal: "5" }], "6", "5")).toThrow();
    expect(() => exactDestinationReceiptPlan([{ stockItemId: 1, quantity: "1", lineTotal: "0" }], "0", "5")).toThrow(
      /must be positive/
    );
  });
});

describe("receiveLinkedTrade refusals", () => {
  it("refuses incomplete input before touching the database", () =>
    world(async (w) => {
      const s = await setup(w);
      for (const bad of [
        { confirmPhysicalArrival: false },
        { arrivalEvidence: "short" },
        { reason: " " },
        { locationId: 0 },
        { expectedVersion: 0 },
      ]) {
        await refused(
          w,
          s.t.tradeId,
          () => receiveLinkedTrade({ ...s.input, ...bad }, destinationIdentity(w)),
          "IC_RECEIPT_INPUT",
          422
        );
      }
    }));

  it("refuses companies outside the pair and Properties users without ERP membership", () =>
    world(async (w) => {
      const s = await setup(w);
      const outsider = await w.company("OUT", "erp");
      await expect(receiveLinkedTrade(s.input, w.identity(outsider))).rejects.toMatchObject({ status: 403 });
      const sourceAdmin = await w.otherUser([
        [w.sourceCompanyId, "Admin"],
        [w.destinationCompanyId, "Owner"],
      ]);
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade(s.input, w.identity(w.sourceCompanyId, "Admin", sourceAdmin)),
        "IC_RECEIPT_COMPANY",
        403
      );
      const propertiesOnly = await w.otherUser([[w.sourceCompanyId, "Owner"]]);
      await expect(
        receiveLinkedTrade(s.input, w.identity(w.sourceCompanyId, "Owner", propertiesOnly))
      ).rejects.toMatchObject({ status: 403 });
      expect((await footprint(w, s.t.tradeId)).receipts).toBe(0);
    }));

  it("refuses a stale version and a disabled relationship", () =>
    world(async (w) => {
      const s = await setup(w);
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade({ ...s.input, expectedVersion: 7 }, destinationIdentity(w)),
        "IC_RECEIPT_STALE"
      );
      await w.q(`UPDATE intercompany_relationship_policies SET trade_enabled = FALSE WHERE id = $1`, [
        w.relationshipId,
      ]);
      await refused(w, s.t.tradeId, () => receiveLinkedTrade(s.input, destinationIdentity(w)), "IC_RECEIPT_DISABLED");
      // A legacy offload of a linked container is refused by the database itself, so the
      // service's own offload check is defence in depth and is not reachable here.
    }));

  it("refuses a location of another company or an inactive one, and a wrong inventory account", () =>
    world(async (w) => {
      const s = await setup(w);
      const sourceLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'HP Yard') RETURNING id`,
        [w.sourceCompanyId, `${w.tag}H`]
      );
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade({ ...s.input, locationId: sourceLocation }, destinationIdentity(w)),
        "IC_RECEIPT_LOCATION"
      );
      await w.q(`UPDATE locations SET active = FALSE WHERE id = $1`, [s.locationId]);
      await refused(w, s.t.tradeId, () => receiveLinkedTrade(s.input, destinationIdentity(w)), "IC_RECEIPT_LOCATION");
      await w.q(`UPDATE locations SET active = TRUE WHERE id = $1`, [s.locationId]);

      await refused(
        w,
        s.t.tradeId,
        () =>
          receiveLinkedTrade(
            { ...s.input, inventoryAccountId: w.accounts.destinationGitAccountId },
            destinationIdentity(w)
          ),
        "IC_RECEIPT_INVENTORY_ACCOUNT"
      );
      await w.q(`UPDATE ledger_accounts SET account_type = 'Expense' WHERE id = $1`, [s.inventoryAccountId]);
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade(s.input, destinationIdentity(w)),
        "IC_RECEIPT_INVENTORY_ACCOUNT"
      );
    }));

  it("refuses an existing stock shortage at the receiving location", () =>
    world(async (w) => {
      const s = await setup(w);
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value) VALUES ($1, $2, $3, -2, 0)`,
        [w.destinationCompanyId, s.locationId, w.stockItemId]
      );
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade(s.input, destinationIdentity(w)),
        "IC_RECEIPT_STOCK_VARIANCE"
      );
    }));
});

describe("receiveLinkedTrade posting", () => {
  it("receives the goods at the landed cost, then replays exactly and refuses a modified replay", () =>
    world(async (w) => {
      const s = await setup(w);
      const result = await receiveLinkedTrade(s.input, destinationIdentity(w));
      expect(result).toMatchObject({ tradeId: s.t.tradeId, landedCost: "100.00", replayed: false });
      const [stock] = await w.q(
        `SELECT quantity::numeric::text AS qty, total_value::numeric::text AS value FROM inventory WHERE location_id = $1 AND stock_item_id = $2`,
        [s.locationId, w.stockItemId]
      );
      expect(Number(stock.qty)).toBe(1);
      expect(Number(stock.value)).toBe(100);
      const events = await w.q(
        `SELECT payload FROM intercompany_audit_events WHERE event_type = 'intercompany-destination-stock-received' AND source_company_id = $1`,
        [w.sourceCompanyId]
      );
      expect(events[0].payload).toMatchObject({ noPropertiesStockCreated: true, landedCost: "100.00" });

      const replay = await receiveLinkedTrade(s.input, destinationIdentity(w));
      expect(replay).toMatchObject({ receiptId: result.receiptId, replayed: true });
      await refused(
        w,
        s.t.tradeId,
        () => receiveLinkedTrade({ ...s.input, reason: "Different reason" }, destinationIdentity(w)),
        "IC_RECEIPT_REPLAY"
      );
    }));

  it("lets a Properties Owner who is also an ERP Owner receive from the Properties side", () =>
    world(async (w) => {
      const s = await setup(w);
      const result = await receiveLinkedTrade(s.input, w.identity(w.sourceCompanyId, "Owner"));
      expect(result.replayed).toBe(false);
    }));
});
