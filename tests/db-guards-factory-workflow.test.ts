/**
 * Factory, container and stock-transfer workflow triggers, exercised in SQL.
 *
 * These triggers either refuse a write (a bale going back to stock while its
 * order is complete, a mix source whose owner cannot be established) or quietly
 * complete one (scan times, tracking defaults, superseded revisions, the
 * supplier on a goods-on-the-way voucher). The quiet ones matter as much: when
 * one stops firing nothing errors, the data is simply wrong from then on. Each
 * test performs the write and reads back what the database did.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectAccepted, expectRefused, insertRow, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";

type Row = Record<string, unknown>;

describe("a bale on a completed order cannot go back to stock", () => {
  async function baleOnOrder(client: PoolClient, orderValues: Row) {
    const company = await seedRow(client, "companies");
    const bale = await seedRow(client, "factory_bales", { company_id: company.id, status: "SOLD" });
    const order = await seedRow(client, "customer_orders", { company_id: company.id, ...orderValues });
    await seedRow(client, "customer_order_bales", { order_id: order.id, bale_id: bale.id });
    return { company, bale, order };
  }
  const restore = "UPDATE factory_bales SET status = 'IN_STOCK' WHERE id = $1 RETURNING id";

  it.each(["VERIFIED", "FINALIZED", "DISPATCHED", "SOLD"])(
    "refuses the restore while its order is %s",
    async (status) => {
      await withRollback(async (client) => {
        const { bale } = await baleOnOrder(client, { status });

        await expectRefused(client, restore, [bale.id], { code: CHECK_VIOLATION, message: "BALE_ON_COMPLETED_ORDER" });

        expect((await reread(client, "factory_bales", bale.id)).status).toBe("SOLD");
      });
    }
  );

  it("allows the restore while the order is still open, or once it has been deleted", async () => {
    await withRollback(async (client) => {
      const open = await baleOnOrder(client, { status: "DRAFT" });
      const deleted = await baleOnOrder(client, { status: "DISPATCHED", deleted_at: "2026-02-01T00:00:00Z" });

      await expectAccepted(client, restore, [open.bale.id]);
      await expectAccepted(client, restore, [deleted.bale.id]);
    });
  });

  it("only looks at orders of the bale's own company, and leaves other status changes alone", async () => {
    await withRollback(async (client) => {
      const { bale } = await baleOnOrder(client, { status: "DISPATCHED" });
      const stranger = await seedRow(client, "companies");
      const foreignBale = await seedRow(client, "factory_bales", { company_id: stranger.id, status: "SOLD" });
      const order = await seedRow(client, "customer_orders", { company_id: bale.company_id, status: "DISPATCHED" });
      await seedRow(client, "customer_order_bales", { order_id: order.id, bale_id: foreignBale.id });

      await expectAccepted(client, restore, [foreignBale.id]);
      await expectAccepted(client, "UPDATE factory_bales SET status = 'RETURNED' WHERE id = $1 RETURNING id", [
        bale.id,
      ]);
    });
  });

  it("does not block an update that leaves a bale in stock, or a restore of a deleted bale", async () => {
    await withRollback(async (client) => {
      const { bale } = await baleOnOrder(client, { status: "DISPATCHED" });
      await client.query("UPDATE factory_bales SET deleted_at = now() WHERE id = $1", [bale.id]);

      await expectAccepted(client, restore, [bale.id]);
      await expectAccepted(client, restore, [bale.id]);
    });
  });
});

describe("a mix source always names the supplier who owns the material", () => {
  async function mixFixture(client: PoolClient) {
    const company = await seedRow(client, "companies");
    const batch = await seedRow(client, "factory_mix_batches", { company_id: company.id });
    const supplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
    const container = await seedRow(client, "factory_containers", { company_id: company.id, supplier_id: supplier.id });
    return { company, batch, supplier, container };
  }
  const source = (client: PoolClient, values: Row) => insertRow(client, "factory_mix_batch_sources", values);
  const refusedSource = async (client: PoolClient, values: Row, message: string) => {
    const names = Object.keys(values);
    await expectRefused(
      client,
      `INSERT INTO factory_mix_batch_sources (weight_kg, cost_per_kg, total_cost, ${names.join(", ")})
       VALUES (1, 1, 1, ${names.map((_, index) => `$${index + 1}`).join(", ")})`,
      names.map((name) => values[name]),
      { code: CHECK_VIOLATION, message }
    );
  };

  it("takes the owner from the container when the writer names none", async () => {
    await withRollback(async (client) => {
      const { batch, supplier, container } = await mixFixture(client);

      const row = await source(client, { mix_batch_id: batch.id, container_id: container.id });

      expect(row.inventory_supplier_id).toBe(supplier.id);
    });
  });

  it("takes the owner from the pricing supplier when there is no container", async () => {
    await withRollback(async (client) => {
      const { batch, supplier } = await mixFixture(client);

      const row = await source(client, { mix_batch_id: batch.id, supplier_id: supplier.id });

      expect(row.inventory_supplier_id).toBe(supplier.id);
    });
  });

  it("clears the owner on a source that is another batch of the same company", async () => {
    await withRollback(async (client) => {
      const { company, batch, supplier } = await mixFixture(client);
      const upstream = await seedRow(client, "factory_mix_batches", { company_id: company.id });

      const row = await source(client, {
        mix_batch_id: batch.id,
        source_batch_id: upstream.id,
        inventory_supplier_id: supplier.id,
      });

      expect(row.inventory_supplier_id).toBeNull();
    });
  });

  it("refuses a source with no owner at all", async () => {
    await withRollback(async (client) => {
      const { batch } = await mixFixture(client);

      await refusedSource(client, { mix_batch_id: batch.id, source_type: "RAW" }, "INVENTORY_SUPPLIER_UNRESOLVED");
    });
  });

  it("refuses a source whose batch is deleted, or whose upstream batch belongs to another company", async () => {
    await withRollback(async (client) => {
      const { company, batch, supplier } = await mixFixture(client);
      const stranger = await seedRow(client, "companies");
      const deletedBatch = await seedRow(client, "factory_mix_batches", {
        company_id: company.id,
        deleted_at: "2026-02-01T00:00:00Z",
      });
      const foreignBatch = await seedRow(client, "factory_mix_batches", { company_id: stranger.id });

      await refusedSource(
        client,
        { mix_batch_id: deletedBatch.id, supplier_id: supplier.id },
        "MIX_BATCH_COMPANY_UNRESOLVED"
      );
      await refusedSource(
        client,
        { mix_batch_id: batch.id, source_batch_id: foreignBatch.id },
        "UPSTREAM_BATCH_COMPANY_MISMATCH"
      );
    });
  });

  it("refuses a container of another company, and an owner that disagrees with the container", async () => {
    await withRollback(async (client) => {
      const { company, batch } = await mixFixture(client);
      const stranger = await seedRow(client, "companies");
      const foreignSupplier = await seedRow(client, "factory_suppliers", { company_id: stranger.id });
      const foreignContainer = await seedRow(client, "factory_containers", {
        company_id: stranger.id,
        supplier_id: foreignSupplier.id,
      });
      const supplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
      const otherSupplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
      const container = await seedRow(client, "factory_containers", {
        company_id: company.id,
        supplier_id: supplier.id,
      });

      await refusedSource(
        client,
        { mix_batch_id: batch.id, container_id: foreignContainer.id },
        "CONTAINER_INVENTORY_SUPPLIER_UNRESOLVED"
      );
      await refusedSource(
        client,
        { mix_batch_id: batch.id, container_id: container.id, supplier_id: otherSupplier.id },
        "CONTAINER_INVENTORY_SUPPLIER_CONFLICT"
      );
    });
  });

  it("refuses an owner from another company, and a pricing supplier that disagrees with the owner", async () => {
    await withRollback(async (client) => {
      const { company, batch, supplier } = await mixFixture(client);
      const stranger = await seedRow(client, "companies");
      const foreignSupplier = await seedRow(client, "factory_suppliers", { company_id: stranger.id });
      const otherSupplier = await seedRow(client, "factory_suppliers", { company_id: company.id });

      await refusedSource(
        client,
        { mix_batch_id: batch.id, supplier_id: foreignSupplier.id },
        "INVENTORY_SUPPLIER_COMPANY_MISMATCH"
      );
      await refusedSource(
        client,
        { mix_batch_id: batch.id, supplier_id: supplier.id, inventory_supplier_id: otherSupplier.id },
        "INVENTORY_SUPPLIER_CONFLICT"
      );
    });
  });

  it("re-checks the owner when the source is edited", async () => {
    await withRollback(async (client) => {
      const { company, batch, supplier } = await mixFixture(client);
      const otherSupplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
      const row = await source(client, { mix_batch_id: batch.id, supplier_id: supplier.id });

      await expectRefused(
        client,
        "UPDATE factory_mix_batch_sources SET supplier_id = $1 WHERE id = $2",
        [otherSupplier.id, row.id],
        { code: CHECK_VIOLATION, message: "INVENTORY_SUPPLIER_CONFLICT" }
      );
      await client.query(
        "UPDATE factory_mix_batch_sources SET supplier_id = $1, inventory_supplier_id = NULL WHERE id = $2",
        [otherSupplier.id, row.id]
      );
      expect((await reread(client, "factory_mix_batch_sources", row.id)).inventory_supplier_id).toBe(otherSupplier.id);
    });
  });
});

describe("values the database fills in on Factory rows", () => {
  it("marks a new supplier stock addition as quantity-only unless the writer says otherwise", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const supplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
      const base = { company_id: company.id, supplier_id: supplier.id };

      const defaulted = await insertRow(client, "factory_raw_material_adjustments", { ...base, type: "add" });
      const explicit = await insertRow(client, "factory_raw_material_adjustments", {
        ...base,
        type: "ADD",
        valuation_basis: "VALUED_TRANSFER",
      });
      const removal = await insertRow(client, "factory_raw_material_adjustments", { ...base, type: "REMOVE" });
      const unowned = await insertRow(client, "factory_raw_material_adjustments", {
        company_id: company.id,
        type: "ADD",
      });

      expect(defaulted.valuation_basis).toBe("QUANTITY_ONLY");
      expect(explicit.valuation_basis).toBe("VALUED_TRANSFER");
      expect(removal.valuation_basis).toBeNull();
      expect(unowned.valuation_basis).toBeNull();
    });
  });

  it("does not put a valuation basis on an existing adjustment when it is edited", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const supplier = await seedRow(client, "factory_suppliers", { company_id: company.id });
      const legacy = await seedRow(client, "factory_raw_material_adjustments", {
        company_id: company.id,
        type: "REMOVE",
      });

      await client.query("UPDATE factory_raw_material_adjustments SET type = 'ADD', supplier_id = $1 WHERE id = $2", [
        supplier.id,
        legacy.id,
      ]);

      expect((await reread(client, "factory_raw_material_adjustments", legacy.id)).valuation_basis).toBeNull();
    });
  });

  it("moves a bale's production attribution when its stock entry date changes", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      const bale = await seedRow(client, "factory_bales", { company_id: company.id, stock_entry_date: "2026-03-01" });
      const other = await seedRow(client, "factory_bales", { company_id: company.id, stock_entry_date: "2026-03-01" });
      const attribution = (baleId: unknown) =>
        seedRow(client, "factory_bale_production_attributions", {
          company_id: company.id,
          bale_id: baleId,
          stock_entry_date: "2026-03-01",
        });
      const moved = await attribution(bale.id);
      const untouched = await attribution(other.id);
      const dateOf = async (row: Row) =>
        (
          await client.query(
            "SELECT stock_entry_date::text AS day FROM factory_bale_production_attributions WHERE id = $1",
            [row.id]
          )
        ).rows[0].day;

      await client.query("UPDATE factory_bales SET stock_entry_date = '2026-03-09' WHERE id = $1", [bale.id]);
      expect(await dateOf(moved)).toBe("2026-03-09");
      expect(await dateOf(untouched)).toBe("2026-03-01");

      // Clearing the date keeps the last known attribution.
      await client.query("UPDATE factory_bales SET stock_entry_date = NULL WHERE id = $1", [bale.id]);
      expect(await dateOf(moved)).toBe("2026-03-09");
    });
  });
});

describe("scan times on customer order bales", () => {
  async function orderAndBale(client: PoolClient) {
    const company = await seedRow(client, "companies");
    const order = await seedRow(client, "customer_orders", { company_id: company.id });
    const bale = await seedRow(client, "factory_bales", { company_id: company.id });
    return { order, bale };
  }

  it("stamps a scanned bale with the time of the scan, and leaves an unscanned one empty", async () => {
    await withRollback(async (client) => {
      const { order, bale } = await orderAndBale(client);
      const second = await seedRow(client, "factory_bales", { company_id: bale.company_id });

      const scanned = await insertRow(client, "customer_order_bales", {
        order_id: order.id,
        bale_id: bale.id,
        scanned_by: "scanner-1",
      });
      const unscanned = await insertRow(client, "customer_order_bales", {
        order_id: order.id,
        bale_id: second.id,
        scanned_by: "  ",
      });

      expect(scanned.scanned_at).toBeInstanceOf(Date);
      expect(unscanned.scanned_at).toBeNull();
    });
  });

  it("keeps a scan time the writer supplies", async () => {
    await withRollback(async (client) => {
      const { order, bale } = await orderAndBale(client);

      const row = await insertRow(client, "customer_order_bales", {
        order_id: order.id,
        bale_id: bale.id,
        scanned_by: "scanner-1",
        scanned_at: "2026-01-05T08:30:00Z",
      });

      expect((row.scanned_at as Date).toISOString()).toBe("2026-01-05T08:30:00.000Z");
    });
  });

  it("carries the original scan time into history, and back when the bale is scanned again", async () => {
    await withRollback(async (client) => {
      const { order, bale } = await orderAndBale(client);
      const original = await insertRow(client, "customer_order_bales", {
        order_id: order.id,
        bale_id: bale.id,
        scanned_by: "scanner-1",
        scanned_at: "2026-01-05T08:30:00Z",
      });

      const history = await insertRow(client, "customer_order_bales_history", {
        original_id: original.id,
        order_id: order.id,
        bale_id: bale.id,
        cancelled_at: "2026-01-06T09:00:00Z",
      });
      expect((history.scanned_at as Date).toISOString()).toBe("2026-01-05T08:30:00.000Z");

      await client.query("DELETE FROM customer_order_bales WHERE id = $1", [original.id]);
      const rescanned = await insertRow(client, "customer_order_bales", {
        order_id: order.id,
        bale_id: bale.id,
        scanned_by: "scanner-2",
      });
      expect((rescanned.scanned_at as Date).toISOString()).toBe("2026-01-05T08:30:00.000Z");
    });
  });
});

describe("supplier tracking defaults on containers", () => {
  async function trackedSupplier(client: PoolClient, defaults: Row = {}) {
    const company = await seedRow(client, "companies");
    const supplier = await seedRow(client, "suppliers", { company_id: company.id });
    await seedRow(client, "supplier_tracking_defaults", {
      company_id: company.id,
      supplier_id: supplier.id,
      shop_name: "  Main Shop ",
      agent_name: "Agent A",
      duty_fee: "1500",
      active: true,
      ...defaults,
    });
    return { company, supplier };
  }
  const container = (client: PoolClient, company: Row, supplier: Row, values: Row = {}) =>
    insertRow(client, "containers", { company_id: company.id, supplier_id: supplier.id, ...values });

  it("fills an empty shop, agent and duty on a new container", async () => {
    await withRollback(async (client) => {
      const { company, supplier } = await trackedSupplier(client);

      const row = await container(client, company, supplier, { shop_name: " ", agent: null, duty_fee: null });

      expect(row).toMatchObject({ shop_name: "Main Shop", agent: "Agent A" });
      expect(Number(row.duty_fee)).toBe(1500);
    });
  });

  it("never overwrites what the writer entered, and treats a duty of zero as entered", async () => {
    await withRollback(async (client) => {
      const { company, supplier } = await trackedSupplier(client);

      const row = await container(client, company, supplier, {
        shop_name: "Other Shop",
        agent: "Agent B",
        duty_fee: "0",
      });

      expect(row).toMatchObject({ shop_name: "Other Shop", agent: "Agent B" });
      expect(Number(row.duty_fee)).toBe(0);
    });
  });

  it("ignores inactive defaults, and falls back to the location's name for the shop", async () => {
    await withRollback(async (client) => {
      const inactive = await trackedSupplier(client, { active: false });
      const company = await seedRow(client, "companies");
      const supplier = await seedRow(client, "suppliers", { company_id: company.id });
      const location = await seedRow(client, "locations", {
        company_id: company.id,
        name: "Port Warehouse",
        active: true,
        deleted_at: null,
      });
      await seedRow(client, "supplier_tracking_defaults", {
        company_id: company.id,
        supplier_id: supplier.id,
        location_id: location.id,
        shop_name: null,
        active: true,
      });

      const untouched = await container(client, inactive.company, inactive.supplier, { shop_name: null, agent: null });
      const located = await container(client, company, supplier, { shop_name: null });

      expect(untouched).toMatchObject({ shop_name: null, agent: null });
      expect(located.shop_name).toBe("Port Warehouse");
    });
  });

  it("swaps the old supplier's defaults for the new supplier's when a container changes supplier", async () => {
    await withRollback(async (client) => {
      const { company, supplier } = await trackedSupplier(client);
      const next = await seedRow(client, "suppliers", { company_id: company.id });
      await seedRow(client, "supplier_tracking_defaults", {
        company_id: company.id,
        supplier_id: next.id,
        shop_name: "Second Shop",
        agent_name: "Agent Z",
        duty_fee: "900",
        active: true,
      });
      const defaulted = await container(client, company, supplier, { shop_name: null, agent: null, duty_fee: null });
      const custom = await container(client, company, supplier, {
        shop_name: "Hand Picked",
        agent: "Agent B",
        duty_fee: "7",
      });

      await client.query("UPDATE containers SET supplier_id = $1 WHERE id = ANY($2::int[])", [
        next.id,
        [defaulted.id, custom.id],
      ]);

      const movedDefaulted = await reread(client, "containers", defaulted.id);
      const movedCustom = await reread(client, "containers", custom.id);
      expect(movedDefaulted).toMatchObject({ shop_name: "Second Shop", agent: "Agent Z" });
      expect(Number(movedDefaulted.duty_fee)).toBe(900);
      expect(movedCustom).toMatchObject({ shop_name: "Hand Picked", agent: "Agent B" });
      expect(Number(movedCustom.duty_fee)).toBe(7);
    });
  });
});

describe("stock transfer revisions supersede one another", () => {
  // Revisions carry their transfer's id without a foreign key, so no transfer row is needed.
  const revision = (client: PoolClient, transfer: Row, number: number, values: Row = {}) =>
    insertRow(client, "stock_transfer_revisions", {
      transfer_id: transfer.id,
      revision_number: number,
      status: "pending",
      created_by: "clerk-1",
      ...values,
    });

  it("supersedes the same user's pending revision and links it to the new one", async () => {
    await withRollback(async (client) => {
      const transfer = { id: 2147100001 };
      const first = await revision(client, transfer, 1, { optional: true });

      const second = await revision(client, transfer, 2);

      expect(await reread(client, "stock_transfer_revisions", first.id)).toMatchObject({
        status: "superseded",
        optional: false,
        reviewed_by: "clerk-1",
        superseded_by_revision_id: second.id,
      });
      expect(second.status).toBe("pending");
    });
  });

  it("leaves other users' revisions, other transfers and already reviewed revisions alone", async () => {
    await withRollback(async (client) => {
      const transfer = { id: 2147100001 };
      const otherTransfer = { id: 2147100002 };
      const colleague = await revision(client, transfer, 1, { created_by: "clerk-2" });
      const elsewhere = await revision(client, otherTransfer, 1);
      const approved = await revision(client, transfer, 2, { status: "approved" });

      await revision(client, transfer, 3);

      for (const [row, status] of [
        [colleague, "pending"],
        [elsewhere, "pending"],
        [approved, "approved"],
      ] as const) {
        expect(await reread(client, "stock_transfer_revisions", row.id)).toMatchObject({
          status,
          superseded_by_revision_id: null,
        });
      }
    });
  });

  it("does not supersede anything when the new revision is not pending or has no author", async () => {
    await withRollback(async (client) => {
      const transfer = { id: 2147100001 };
      const pending = await revision(client, transfer, 1);

      await revision(client, transfer, 2, { status: "approved" });
      await revision(client, transfer, 3, { created_by: null });

      expect((await reread(client, "stock_transfer_revisions", pending.id)).status).toBe("pending");
    });
  });
});

describe("the supplier on a goods-on-the-way voucher follows its container", () => {
  async function fixture(client: PoolClient, voucherValues: Row = {}) {
    const company = await seedRow(client, "companies");
    const supplier = await seedRow(client, "suppliers", { company_id: company.id });
    const next = await seedRow(client, "suppliers", { company_id: company.id });
    const voucher = await seedRow(client, "vouchers", {
      company_id: company.id,
      voucher_date: "2026-03-10",
      optional: true,
      supplier_id: null,
      ...voucherValues,
    });
    return { company, supplier, next, voucher };
  }
  const supplierOf = async (client: PoolClient, voucher: Row) =>
    (await reread(client, "vouchers", voucher.id)).supplier_id;

  it("fills an empty voucher supplier when the container is linked, and never replaces one", async () => {
    await withRollback(async (client) => {
      const empty = await fixture(client);
      const taken = await fixture(client);
      await client.query("UPDATE vouchers SET supplier_id = $1 WHERE id = $2", [taken.next.id, taken.voucher.id]);

      for (const { company, supplier, voucher } of [empty, taken]) {
        await insertRow(client, "sp_containers", {
          company_id: company.id,
          supplier_id: supplier.id,
          goods_otw_voucher_id: voucher.id,
        });
      }

      expect(await supplierOf(client, empty.voucher)).toBe(empty.supplier.id);
      expect(await supplierOf(client, taken.voucher)).toBe(taken.next.id);
    });
  });

  it("moves an unposted voucher and its clearing lines to the container's new supplier", async () => {
    await withRollback(async (client) => {
      const { company, supplier, next, voucher } = await fixture(client);
      const clearing = await seedRow(client, "ledger_accounts", {
        company_id: company.id,
        sub_type: "sp_otw_clearing",
      });
      const other = await seedRow(client, "ledger_accounts", { company_id: company.id, sub_type: "expense" });
      const line = (ledger: Row) =>
        seedRow(client, "voucher_entries", {
          voucher_id: voucher.id,
          company_id: company.id,
          ledger_account_id: ledger.id,
          supplier_id: supplier.id,
          debit_amount: "10",
          credit_amount: "0",
        });
      const clearingLine = await line(clearing);
      const otherLine = await line(other);
      const container = await insertRow(client, "sp_containers", {
        company_id: company.id,
        supplier_id: supplier.id,
        goods_otw_voucher_id: voucher.id,
      });

      await client.query("UPDATE sp_containers SET supplier_id = $1 WHERE id = $2", [next.id, container.id]);

      expect(await supplierOf(client, voucher)).toBe(next.id);
      expect((await reread(client, "voucher_entries", clearingLine.id)).supplier_id).toBe(next.id);
      expect((await reread(client, "voucher_entries", otherLine.id)).supplier_id).toBe(supplier.id);
    });
  });

  it("never rewrites the supplier of a posted or deleted voucher", async () => {
    await withRollback(async (client) => {
      for (const voucherValues of [{ optional: false }, { deleted_at: "2026-03-11T00:00:00Z" }]) {
        const { company, supplier, next, voucher } = await fixture(client, voucherValues);
        const container = await insertRow(client, "sp_containers", {
          company_id: company.id,
          supplier_id: supplier.id,
          goods_otw_voucher_id: voucher.id,
        });

        await client.query("UPDATE sp_containers SET supplier_id = $1 WHERE id = $2", [next.id, container.id]);

        expect(await supplierOf(client, voucher)).toBe(supplier.id);
      }
    });
  });
});
