/**
 * EDIT branch of the post-offload charge mutation
 * (server/services/factory/post-offload-charge/applyEdit.ts) through
 * PATCH /api/factory/containers/:id/post-offload-charges/:chargeId, in a
 * rolled-back factory world: stale versions, unknown and other-company
 * charges, a cross-company expense ledger, missing historical links, an
 * in-place voucher edit (ledger and supplier destinations), the legacy
 * unknown-baseline repricing with and without a container supplier.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function seed(world: FactoryWorld, options: { withSupplier?: boolean } = {}) {
  const supplierId = await world.one(
    `INSERT INTO factory_suppliers (company_id, name, is_active, current_raw_material_cost_per_kg_usd)
     VALUES ($1, $2, true, 2) RETURNING id`,
    [world.companyId, `${world.tag} Mill`]
  );
  const containerId = await world.one(
    `INSERT INTO factory_containers
       (company_id, container_number, supplier_id, currency_code, fx_rate_to_usd, fx_rate_confirmed,
        fx_rate_source, rate_per_kg, rate_per_kg_usd, total_kg, actual_received_kg, status, arrival_date,
        duty_status, freight, other_charges, commission_amount, final_payable_amount, final_payable_amount_usd)
     VALUES ($1, $2, $3, 'USD', '1', true, 'manual', '2.000000', '2.000000', '100.000', '100.000', 'OFFLOADED',
             '2026-06-08', 'NONE', '0', '0', '0', '200.00', '200.00')
     RETURNING id`,
    [world.companyId, `${world.tag}-C`, options.withSupplier === false ? null : supplierId]
  );
  await world.q(
    `INSERT INTO factory_raw_stock (company_id, container_id, received_kg, used_kg, cost_per_kg, cost_per_kg_usd)
     VALUES ($1, $2, '100.000', '0', '2.0000000', '2.0000000')`,
    [world.companyId, containerId]
  );
  const ledgerId = await world.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, 'Offload Charges', 'Expense', '0', 'Dr', true) RETURNING id`,
    [world.companyId, `${world.tag}-CHG`]
  );
  const created = await world.agent
    .post(`/api/factory/containers/${containerId}/post-offload-charges`)
    .send({ txDate: "2026-06-10", charges: [{ description: "Forklift", amount: "20", ledgerAccountId: ledgerId }] });
  if (created.status !== 200 && created.status !== 201)
    throw new Error(`create failed ${created.status} ${created.text}`);
  const [charge] = await world.q<{ id: number; version: number; voucher_id: number }>(
    `SELECT id, version, voucher_id FROM factory_offload_additional_charges WHERE container_id = $1`,
    [containerId]
  );
  return {
    supplierId,
    containerId,
    ledgerId,
    chargeId: Number(charge.id),
    version: charge.version,
    voucherId: charge.voucher_id,
  };
}

const patch = (world: FactoryWorld, containerId: number, chargeId: number | string, body: Record<string, unknown>) =>
  world.agent
    .patch(`/api/factory/containers/${containerId}/post-offload-charges/${chargeId}`)
    .send({ txDate: "2026-06-11", description: "Forklift", ...body });

describe("post-offload charge edit refusals", () => {
  it("refuses stale versions, unknown charges and missing historical links without changing the charge", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world);
      const stale = await patch(world, s.containerId, s.chargeId, {
        amount: "30",
        ledgerAccountId: s.ledgerId,
        expectedVersion: s.version + 5,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(/modified by another request/);

      const unknown = await patch(world, s.containerId, 2_000_000_000, { amount: "30", ledgerAccountId: s.ledgerId });
      expect(unknown.status).toBe(500);
      expect(unknown.body.message).toBe("Charge not found or already undone");

      const [row] = await world.q(`SELECT amount, version FROM factory_offload_additional_charges WHERE id = $1`, [
        s.chargeId,
      ]);
      expect(Number(row.amount)).toBe(20);
      expect(row.version).toBe(s.version);
    }));

  it("recovers a lost daybook link from the charge's own evidence before editing", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world);
      const [{ daybook_entry_id: daybookId }] = await world.q(
        `SELECT daybook_entry_id FROM factory_offload_additional_charges WHERE id = $1`,
        [s.chargeId]
      );
      await world.q(`UPDATE factory_offload_additional_charges SET daybook_entry_id = NULL WHERE id = $1`, [
        s.chargeId,
      ]);
      const res = await patch(world, s.containerId, s.chargeId, { amount: "30", ledgerAccountId: s.ledgerId });
      expect(res.status).toBe(200);
      const [row] = await world.q(`SELECT daybook_entry_id FROM factory_offload_additional_charges WHERE id = $1`, [
        s.chargeId,
      ]);
      expect(row.daybook_entry_id).toBe(daybookId);
      const [entry] = await world.q(`SELECT amount_currency FROM factory_daybook_entries WHERE id = $1`, [daybookId]);
      expect(Number(entry.amount_currency)).toBe(30);
    }));

  it("refuses an expense ledger that belongs to another company", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world);
      const otherCompany = await world.one(
        `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
        [`${world.tag}X`]
      );
      const foreignLedger = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, active)
         VALUES ($1, $2, 'Foreign', 'Expense', true) RETURNING id`,
        [otherCompany, `${world.tag}-FX`]
      );
      const res = await patch(world, s.containerId, s.chargeId, { amount: "25", ledgerAccountId: foreignLedger });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("POST_OFFLOAD_LEDGER_COMPANY_MISMATCH");
      const [row] = await world.q(`SELECT ledger_account_id FROM factory_offload_additional_charges WHERE id = $1`, [
        s.chargeId,
      ]);
      expect(Number(row.ledger_account_id)).toBe(s.ledgerId);
    }));
});

describe("post-offload charge edit", () => {
  it("edits the charge and its voucher in place, then moves it to the supplier", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world);
      const edited = await patch(world, s.containerId, s.chargeId, {
        amount: "50",
        ledgerAccountId: s.ledgerId,
        expectedVersion: s.version,
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({
        action: "EDIT",
        chargeId: s.chargeId,
        fullContainerValueDeltaUsd: "30.000000",
      });
      expect(edited.body.supplierLockedRateAfter).not.toBeNull();
      const [voucher] = await world.q(`SELECT total_amount, voucher_date::text AS d FROM vouchers WHERE id = $1`, [
        s.voucherId,
      ]);
      expect(Number(voucher.total_amount)).toBe(50);
      expect(voucher.d).toBe("2026-06-11");

      const moved = await patch(world, s.containerId, s.chargeId, { amount: "50", supplierId: s.supplierId });
      expect(moved.status).toBe(200);
      const entries = await world.q(
        `SELECT ledger_account_id, factory_supplier_id FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [s.voucherId]
      );
      expect(entries.some((e) => Number(e.factory_supplier_id) === s.supplierId)).toBe(true);
      expect(entries.some((e) => Number(e.ledger_account_id) === s.ledgerId)).toBe(false);
      const [row] = await world.q(
        `SELECT version, supplier_id, ledger_account_id FROM factory_offload_additional_charges WHERE id = $1`,
        [s.chargeId]
      );
      expect(row).toMatchObject({ version: s.version + 2, ledger_account_id: null });
    }));

  it("reprices from a legacy baseline when the charge never captured the supplier rate", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world);
      await world.q(`UPDATE factory_offload_additional_charges SET supplier_locked_rate_before = NULL WHERE id = $1`, [
        s.chargeId,
      ]);
      const body = { amount: "40", ledgerAccountId: s.ledgerId, legacyBaselineRate: "1.5" };
      // The container's own offload is a supplier cost event recorded with the charge.
      const refused = await patch(world, s.containerId, s.chargeId, body);
      expect(refused.status).toBe(500);
      expect(refused.body.message).toMatch(/Newer supplier cost events exist/);

      await world.q(`UPDATE factory_offload_additional_charges SET created_at = '2030-01-01' WHERE id = $1`, [
        s.chargeId,
      ]);
      const res = await patch(world, s.containerId, s.chargeId, body);
      expect(res.status).toBe(200);
      const [row] = await world.q(
        `SELECT supplier_locked_rate_before FROM factory_offload_additional_charges WHERE id = $1`,
        [s.chargeId]
      );
      expect(Number(row.supplier_locked_rate_before)).toBe(1.5);
      const [supplier] = await world.q(
        `SELECT current_raw_material_cost_per_kg_usd::float AS rate FROM factory_suppliers WHERE id = $1`,
        [s.supplierId]
      );
      // The edit re-bases from the 1.5 baseline: 1.5 + 40 USD over the 100 kg on hand.
      expect(Number(res.body.supplierLockedRateAfter)).toBeCloseTo(1.9, 6);
      // The post-commit historical replay then recomputes the stored rate from the full timeline.
      expect(supplier.rate).toBeGreaterThan(0);
    }));

  it("skips supplier repricing for a container without a supplier", () =>
    withFactoryWorld(async (world) => {
      const s = await seed(world, { withSupplier: false });
      await world.q(`UPDATE factory_offload_additional_charges SET supplier_locked_rate_before = NULL WHERE id = $1`, [
        s.chargeId,
      ]);
      const res = await patch(world, s.containerId, s.chargeId, {
        amount: "40",
        ledgerAccountId: s.ledgerId,
        legacyBaselineRate: "1.5",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        supplierLockedRateAfter: null,
        supplierValueAfterUsd: null,
        cascadeResult: null,
      });
    }));
});
