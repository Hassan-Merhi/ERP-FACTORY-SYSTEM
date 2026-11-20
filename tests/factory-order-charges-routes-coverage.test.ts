/**
 * Customer-order charge routes (orderChargesRoutes) through the real app
 * inside one rolled-back transaction: validation and company scope, charges
 * on an open loading (no ledger effect), and on a finalized invoice - the
 * no-account warning, the posted charge voucher, relinking by account name,
 * the "nothing to relink" and "could not match" answers, amount edits of a
 * posted voucher, linking an account later, and delete retiring the voucher.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks, ledger, loadingWithBales } from "./helpers/dispatchFlowFixture";

const charges = (orderId: number | string) => `/api/factory/customer-orders/${orderId}/charges`;

const chargeRows = (w: FactoryWorld, orderId: number) =>
  w.q<{ id: number; name: string; amount: string; voucher_id: number | null; ledger_account_id: number | null }>(
    `SELECT id, name, amount::text AS amount, voucher_id, ledger_account_id FROM customer_order_charges
      WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );

const liveVoucher = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT total_amount::text AS total, deleted_at IS NULL AS live FROM vouchers WHERE id = $1`, [id]))[0];

async function finalized(w: FactoryWorld) {
  const { orderId, customerId } = await loadingWithBales(w, ["10.00"]);
  await w.q(`UPDATE customer_orders SET status = 'FINALIZED', invoice_number = $2 WHERE id = $1`, [
    orderId,
    `${w.tag}-INV`,
  ]);
  return { orderId, customerId };
}

describe("order charge refusals", () => {
  it("validates ids and input and stays in this company", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      expect((await w.agent.post(charges("abc")).send({ name: "x", amount: 1 })).status).toBe(400);
      expect((await w.agent.post(charges(orderId)).send({ name: "x" })).body.message).toBe(
        "name and amount are required"
      );
      expect((await w.agent.post(charges(2147483000)).send({ name: "x", amount: 1 })).status).toBe(404);
      expect((await w.agent.post(`${charges("abc")}/relink-vouchers`).send({})).status).toBe(400);
      expect((await w.agent.post(`${charges(2147483000)}/relink-vouchers`).send({})).status).toBe(404);
      expect((await w.agent.post(`${charges(orderId)}/relink-vouchers`).send({})).body.message).toBe(
        "Order is not finalized"
      );
      expect((await w.agent.patch(`${charges("abc")}/1`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${charges(orderId)}/abc`).send({ name: "x" })).status).toBe(400);
      expect((await w.agent.patch(`${charges(orderId)}/1`).send({})).body.message).toBe("Nothing to update");
      expect((await w.agent.patch(`${charges(orderId)}/1`).send({ amount: "abc" })).body.message).toBe(
        "Invalid amount"
      );
      expect((await w.agent.patch(`${charges(orderId)}/2147483000`).send({ name: "x" })).status).toBe(404);
      expect((await w.agent.patch(`${charges(2147483000)}/1`).send({ name: "x" })).status).toBe(404);
      expect((await w.agent.delete(`${charges("abc")}/1`)).status).toBe(400);
      expect((await w.agent.delete(`${charges(orderId)}/abc`)).status).toBe(400);
      expect((await w.agent.delete(`${charges(2147483000)}/1`)).status).toBe(404);
      expect(await chargeRows(w, orderId)).toEqual([]);
    }));
});

describe("order charges", () => {
  it("keeps charges on an open loading out of the ledger", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      const account = await ledger(w, "FRT", "Income");
      const added = await w.agent
        .post(charges(orderId))
        .send({ name: "Freight", amount: "25.50", ledgerAccountId: account });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body.warning).toBeUndefined();
      const [charge] = await chargeRows(w, orderId);
      expect(charge).toMatchObject({ name: "Freight", amount: "25.50", voucher_id: null });

      const edited = await w.agent
        .patch(`${charges(orderId)}/${charge.id}`)
        .send({ amount: "30", name: "Freight 2", ledgerAccountId: "" });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect((await chargeRows(w, orderId))[0]).toMatchObject({
        name: "Freight 2",
        amount: "30.00",
        ledger_account_id: null,
      });

      const removed = await w.agent.delete(`${charges(orderId)}/${charge.id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.charges).toEqual([]);
    }));

  it("posts, relinks, edits and retires charge vouchers on a finalized invoice", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await finalized(w);
      const account = await ledger(w, "SUR", "Income");
      const [acct] = await w.q<{ name: string }>(`SELECT name FROM ledger_accounts WHERE id = $1`, [account]);

      const unlinked = await w.agent.post(charges(orderId)).send({ name: acct.name, amount: "5" });
      expect(unlinked.status, JSON.stringify(unlinked.body)).toBe(200);
      expect(unlinked.body.warning).toMatch(/no ledger account was linked/);
      const orphan = await w.agent.post(charges(orderId)).send({ name: "Mystery fee", amount: "3" });
      expect(orphan.status).toBe(200);

      const posted = await w.agent
        .post(charges(orderId))
        .send({ name: "Handling", amount: "12.00", ledgerAccountId: String(account), chargeType: "HANDLING" });
      expect(posted.status, JSON.stringify(posted.body)).toBe(200);
      let rows = await chargeRows(w, orderId);
      const handling = rows.find((r) => r.name === "Handling")!;
      expect(handling.voucher_id).not.toBeNull();
      expect(await liveVoucher(w, Number(handling.voucher_id))).toEqual({ total: "12.00", live: true });

      const relink = await w.agent.post(`${charges(orderId)}/relink-vouchers`).send({});
      expect(relink.status, JSON.stringify(relink.body)).toBe(200);
      expect(relink.body.linked).toBe(1);
      expect(relink.body.message).toMatch(/1 charge successfully linked.*1 skipped .*Mystery fee/);
      const again = await w.agent.post(`${charges(orderId)}/relink-vouchers`).send({});
      expect(again.body).toEqual({
        linked: 0,
        message:
          "No charges could be linked. Could not auto-match: Mystery fee. Link a ledger account to each charge first.",
      });

      const repriced = await w.agent.patch(`${charges(orderId)}/${handling.id}`).send({ amount: "15" });
      expect(repriced.status, JSON.stringify(repriced.body)).toBe(200);
      expect((await liveVoucher(w, Number(handling.voucher_id))).total).toBe("15.00");

      rows = await chargeRows(w, orderId);
      const mystery = rows.find((r) => r.name === "Mystery fee")!;
      const linkLater = await w.agent
        .patch(`${charges(orderId)}/${mystery.id}`)
        .send({ ledgerAccountId: String(account) });
      expect(linkLater.status, JSON.stringify(linkLater.body)).toBe(200);
      const [linked] = await w.q(`SELECT voucher_id FROM customer_order_charges WHERE id = $1`, [mystery.id]);
      expect(linked.voucher_id).not.toBeNull();

      const nothing = await w.agent.post(`${charges(orderId)}/relink-vouchers`).send({});
      expect(nothing.body.message).toBe("All charges already have ledger entries — nothing to relink.");

      const removed = await w.agent.delete(`${charges(orderId)}/${handling.id}`);
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect((await liveVoucher(w, Number(handling.voucher_id))).live).toBe(false);
    }));

  it("finds a legacy charge voucher by number when the charge has no link", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await finalized(w);
      const added = await w.agent.post(charges(orderId)).send({ name: "Old fee", amount: "4" });
      const charge = added.body.charges[0];
      const legacy = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 0) RETURNING id`,
        [w.companyId, `CHARGE-${w.tag}-INV-${charge.id}-1`]
      );
      const res = await w.agent.delete(`${charges(orderId)}/${charge.id}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await liveVoucher(w, legacy)).live).toBe(false);
    }));

  it("names container charges after the container and refuses a closed period", () =>
    withFactoryWorld(async (w) => {
      const { orderId } = await finalized(w);
      await w.q(`UPDATE customer_orders SET container_number = 'CONT-9' WHERE id = $1`, [orderId]);
      const account = await ledger(w, "CNT", "Income");
      const added = await w.agent.post(charges(orderId)).send({ name: "Fuel", amount: "7", ledgerAccountId: account });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      const [fuel] = await chargeRows(w, orderId);
      const [voucher] = await w.q(`SELECT description FROM vouchers WHERE id = $1`, [fuel.voucher_id]);
      expect(voucher.description).toBe("Fuel for offloaded container - CONT-9");

      const late = await w.agent.post(charges(orderId)).send({ name: "Late", amount: "2" });
      const lateId = late.body.charges.find((c: { name: string }) => c.name === "Late").id;
      const linked = await w.agent.patch(`${charges(orderId)}/${lateId}`).send({ ledgerAccountId: account });
      expect(linked.status).toBe(200);
      const [lateRow] = await w.q(
        `SELECT v.description FROM customer_order_charges c JOIN vouchers v ON v.id = c.voucher_id WHERE c.id = $1`,
        [lateId]
      );
      expect(lateRow.description).toBe("Late for container - CONT-9");

      await closeBooks(w, "2026-12-31");
      const before = await chargeRows(w, orderId);
      await w.q(`SAVEPOINT closed_charge`);
      const closed = await w.agent
        .post(charges(orderId))
        .send({ name: "Closed", amount: "3", ledgerAccountId: account });
      expect(closed.status).toBe(409);
      await w.q(`ROLLBACK TO SAVEPOINT closed_charge`);
      expect(await chargeRows(w, orderId)).toEqual(before);
    }));
});
