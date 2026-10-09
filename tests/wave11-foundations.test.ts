/**
 * Wave 11 ("inventory fidelity") foundations.
 *
 *   - the new registry accounts are provisioned once, never twice;
 *   - the stock valuation reader sums inventory.total_value: short rows hold no
 *     value, the rounding residual qty × rate would lose is kept, inactive
 *     locations are counted and reported apart, bale-mirror items are left out
 *     (and reported), and the as-of variant replays from total_value;
 *   - the inventory movement journal is a no-op before the cut-over and for a
 *     supplier partner, posts a balanced Dr/Cr after, is replaced whole on a
 *     re-sync and can be removed;
 *   - adjustInventory reports the stored value delta;
 *   - the boot DDL is idempotent;
 *   - the admin-tool refusal is a 409 PERPETUAL_INVENTORY_ACTIVE after the cut-over.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { adjustInventory } from "../server/inventoryHelper";
import { classifyAccountType } from "../server/services/accounting/accountClassification";
import { ensureInventoryCutoverSchema } from "../server/services/accounting/perpetualInventory/cutover";
import {
  assertNoInventoryCutoverTx,
  InventoryCutoverRefusalError,
  inventoryCutoverRefusal,
  PERPETUAL_INVENTORY_ACTIVE,
  PERPETUAL_INVENTORY_ACTIVE_MESSAGE,
} from "../server/services/accounting/perpetualInventory/cutoverRefusal";
import { factoryBaleMirrorStockItemIds } from "../server/services/accounting/perpetualInventory/factoryValuation";
import {
  inventoryMovementLine,
  inventoryMovementVoucherNumber,
  postInventoryMovementJournalTx,
  removeInventoryMovementJournalTx,
} from "../server/services/accounting/perpetualInventory/inventoryMovementJournal";
import { ensureSystemAccounts, systemAccountDefinition } from "../server/services/accounting/systemAccounts";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import {
  ensureInventoryFidelitySchema,
  VALUE_MOVED_TABLES,
} from "../server/services/inventory/inventoryFidelitySchema";
import {
  companyStockValuation,
  companyStockValuationAsOf,
  locationStockValuation,
} from "../server/services/inventory/stockValuation";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";

const PREFIX = `w11${Date.now().toString(36)}`;
const WAVE11_CODES = [
  "INVENTORY_ADJUSTMENT",
  "INVENTORY_REVALUATION",
  "FACTORY_WASTE_WRITE_OFF",
  "FACTORY_REVALUATION",
  "FACTORY_MATERIAL_PRICE_VARIANCE",
] as const;

let companyId: number;
let spCompanyId: number;
let activeLocation: number;
let inactiveLocation: number;
let deletedLocation: number;
let itemA: number;
let itemB: number;
let mirrorItem: number;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("wave11-foundations-test", work);

async function journalLines(company: number, voucherNumber: string) {
  const { rows } = await pool.query(
    `SELECT la.code, ve.debit_amount::text AS d, ve.credit_amount::text AS c
       FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = $1 AND v.voucher_number = $2 ORDER BY la.code`,
    [company, voucherNumber]
  );
  return rows.map((row) => [row.code, row.d, row.c]);
}

beforeAll(async () => {
  expect(await ensureInventoryCutoverSchema(pool)).toBe(true);
  await ensureInventoryFidelitySchema(pool);
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const company = async (suffix: string, type: string | null) =>
      (
        await client.query(
          `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, COALESCE($2, 'erp')) RETURNING id`,
          [`${PREFIX}${suffix}`.toUpperCase(), type]
        )
      ).rows[0].id as number;
    companyId = await company("C", null);
    spCompanyId = await company("S", "supplier_partner");
    const location = async (suffix: string, active: boolean, deleted: boolean) =>
      (
        await client.query(
          `INSERT INTO locations (company_id, code, name, active, deleted_at)
           VALUES ($1, $2::varchar, $2::text, $3, CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id`,
          [companyId, `${PREFIX}-${suffix}`, active, deleted]
        )
      ).rows[0].id as number;
    activeLocation = await location("A", true, false);
    inactiveLocation = await location("I", false, false);
    deletedLocation = await location("D", true, true);
    const item = async (code: string, uom: string) =>
      (
        await client.query(
          `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2::varchar, $2::text, $3) RETURNING id`,
          [companyId, `${PREFIX}-${code}`, uom]
        )
      ).rows[0].id as number;
    itemA = await item("A", "PCS");
    itemB = await item("B", "PCS");
    mirrorItem = await item("BALE", "BALE");
    await client.query(
      `INSERT INTO factory_bale_products (company_id, code, name) VALUES ($1, $2::varchar, $2::text)`,
      [companyId, `${PREFIX}-BALE`]
    );
    const stock = (location: number, stockItem: number, qty: string, rate: string, value: string) =>
      client.query(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [companyId, location, stockItem, qty, rate, value]
      );
    // 3 units holding 10.00: qty × rate (3.33) would say 9.99; the stored value is kept.
    await stock(activeLocation, itemA, "3", "3.33", "10.00");
    // A short row: negative stock holds no value and does not subtract.
    await stock(activeLocation, itemB, "-4", "5.00", "0.00");
    await stock(inactiveLocation, itemA, "2", "2.50", "5.00");
    // An anomalous short row with a stored value: reported, not counted.
    await stock(inactiveLocation, itemB, "0", "1.00", "1.50");
    await stock(deletedLocation, itemA, "1", "7.00", "7.00");
    await stock(activeLocation, mirrorItem, "2", "40.00", "80.00");
  });
}, 60000);

afterAll(async () => {
  await withFixtureTransaction(
    async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      const ids = [companyId, spCompanyId];
      await client.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = ANY($1)`, [ids]);
      await client.query(
        `DELETE FROM accounting_posting_requests WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1))`,
        [ids]
      );
      await client.query(
        `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1))`,
        [ids]
      );
      await client.query(
        `DELETE FROM stock_adjustment_items WHERE stock_item_id IN (SELECT id FROM stock_items WHERE company_id = ANY($1))`,
        [ids]
      );
      await client.query(
        `DELETE FROM stock_adjustment_vouchers WHERE location_id IN (SELECT id FROM locations WHERE company_id = ANY($1))`,
        [ids]
      );
      await client.query(`DELETE FROM vouchers WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM inventory_negative_layers WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM inventory WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM factory_bale_products WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM stock_items WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM locations WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1)`, [ids]);
      await client.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
    },
    { legacyUnbalanced: true }
  );
  // audit_log is append-only (wave 12); the test's own rows go through the cleanup helper.
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1)", [[companyId, spCompanyId]]);
}, 60000);

describe("wave 11 registry accounts", () => {
  it("are profit-and-loss accounts provisioned once", async () => {
    for (const code of WAVE11_CODES) {
      const definition = systemAccountDefinition(code);
      expect(definition, code).toBeDefined();
      expect(definition!.required).toBe(false);
      expect(classifyAccountType(definition!.accountType)).toBe("expense");
    }
    const first = await asMaintenance(() => db.transaction((tx) => ensureSystemAccounts(tx, companyId, WAVE11_CODES)));
    expect(first.map((status) => status.state)).toEqual(WAVE11_CODES.map(() => "created"));
    const second = await asMaintenance(() => db.transaction((tx) => ensureSystemAccounts(tx, companyId, WAVE11_CODES)));
    expect(second.map((status) => status.state)).toEqual(WAVE11_CODES.map(() => "ok"));
    const { rows } = await pool.query(
      `SELECT code, COUNT(*)::int AS n FROM ledger_accounts WHERE company_id = $1 AND code = ANY($2) GROUP BY code`,
      [companyId, WAVE11_CODES]
    );
    expect(rows).toHaveLength(WAVE11_CODES.length);
    expect(rows.every((row) => row.n === 1)).toBe(true);
  });
});

describe("stock valuation", () => {
  it("sums total_value under the documented location scope", async () => {
    const valuation = await companyStockValuation(db, companyId);
    expect(valuation).toMatchObject({
      companyId,
      asOf: null,
      scope: "ALL_NON_DELETED_LOCATIONS",
      total: "15.00",
      activeLocationValue: "10.00",
      inactiveLocationValue: "5.00",
      excluded: {
        baleMirrorValue: "80.00",
        deletedLocationValue: "7.00",
        shortRowValue: "1.50",
        negativeValue: "0.00",
        anomalousRows: 1,
      },
    });
    expect(valuation.locations.map((location) => [location.locationId, location.active, location.value])).toEqual([
      [activeLocation, true, "10.00"],
      [inactiveLocation, false, "5.00"],
    ]);
    expect(await locationStockValuation(db, companyId, inactiveLocation)).toMatchObject({
      value: "5.00",
      active: false,
    });
    expect(await locationStockValuation(db, companyId, deletedLocation)).toBeNull();
  });

  it("leaves out exactly the items the perpetual INVENTORY account leaves out", async () => {
    expect([...(await factoryBaleMirrorStockItemIds(db, companyId))]).toEqual([mirrorItem]);
  });

  it("replays the as-of value from total_value", async () => {
    // A production of 5 units of item A worth 50.00 at the active location, dated after the as-of date.
    await withFixtureTransaction(async (client) => {
      await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
      const voucher = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id)
           VALUES ($1, $2, 'Production', '2026-09-10', 0, $3) RETURNING id`,
          [companyId, `${PREFIX}-PROD`, activeLocation]
        )
      ).rows[0].id;
      const adjustment = (
        await client.query(
          `INSERT INTO stock_adjustment_vouchers (voucher_id, location_id, adjustment_type) VALUES ($1, $2, 'Production') RETURNING id`,
          [voucher, activeLocation]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, 5, 10, 50)`,
        [adjustment, itemA]
      );
      await client.query(
        `UPDATE inventory SET quantity = quantity + 5, total_value = total_value + 50 WHERE location_id = $1 AND stock_item_id = $2`,
        [activeLocation, itemA]
      );
    });
    expect((await companyStockValuation(db, companyId)).total).toBe("65.00");
    const before = await companyStockValuationAsOf(db, companyId, "2026-09-01");
    expect(before).toMatchObject({
      asOf: "2026-09-01",
      total: "15.00",
      activeLocationValue: "10.00",
      inactiveLocationValue: "5.00",
    });
    expect(before.excluded.baleMirrorValue).toBe("80.00");
    expect((await companyStockValuationAsOf(db, companyId, "2026-09-30")).total).toBe("65.00");
  });
});

describe("adjustInventory value delta", () => {
  it("reports the signed change of the stored total_value", async () => {
    const result = await db.transaction((tx) => adjustInventory(tx, activeLocation, itemA, -1, companyId));
    // 8 units holding 60.00 at a stored rate of 3.33 (the fixture added 5 units
    // worth 50.00 without touching the rate): the stored rate no longer
    // reproduces the stored value, so the issue relieves at total_value / qty
    // = 7.50 (wave 11, agent A). Relieving the stale 3.33 left the row 4.17
    // over-valued per unit issued.
    expect(result.valueDelta).toBe("-7.50");
    expect(result.newTotalValue - result.previousTotalValue).toBeCloseTo(-7.5, 6);
    const received = await db.transaction((tx) => adjustInventory(tx, activeLocation, itemA, 2, companyId, 1.005));
    expect(received.valueDelta).toBe("2.01");
  });
});

describe("inventory movement journal", () => {
  const source = () => ({ companyId, sourceType: "quick-adjust", sourceId: 42 });
  const post = (valueDeltas: string[], company = companyId, date = "2026-10-05") =>
    asMaintenance(() =>
      db.transaction((tx) =>
        postInventoryMovementJournalTx(tx, {
          ...source(),
          companyId: company,
          date,
          reference: "QA-42",
          lines: valueDeltas.map((valueDelta) => inventoryMovementLine({ valueDelta }, { stockItemId: itemA })),
          offsetAccountCode: "INVENTORY_ADJUSTMENT",
          narration: "Stock count",
          actor: { userId: "test-user", username: "tester" },
        })
      )
    );

  it("is a no-op before the cut-over", async () => {
    expect(await post(["12.34"])).toBeNull();
    expect(await journalLines(companyId, inventoryMovementVoucherNumber(source()))).toEqual([]);
  });

  it("posts a balanced journal after the cut-over, replaces it on re-sync and removes it", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-10-01', '{}'::jsonb, 'test')`,
      [companyId]
    );
    const voucherNumber = inventoryMovementVoucherNumber(source());
    expect(voucherNumber).toBe(`INV-MOVE-${companyId}-quick-adjust-42`);
    expect(await post(["12.34"], companyId, "2026-09-30")).toBeNull();

    const gain = await post(["10.00", "2.34"]);
    expect(gain).toMatchObject({ voucherNumber, net: "12.34" });
    expect(await journalLines(companyId, voucherNumber)).toEqual([
      ["INVENTORY", "12.34", "0.00"],
      ["INVENTORY_ADJUSTMENT", "0.00", "12.34"],
    ]);

    const loss = await post(["-5.00", "1.50"]);
    expect(loss).toMatchObject({ voucherNumber, net: "-3.50" });
    expect(await journalLines(companyId, voucherNumber)).toEqual([
      ["INVENTORY", "0.00", "3.50"],
      ["INVENTORY_ADJUSTMENT", "3.50", "0.00"],
    ]);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
      [companyId, voucherNumber]
    );
    expect(rows[0].n).toBe(1);

    // A zero net removes the journal.
    expect(await post(["1.00", "-1.00"])).toBeNull();
    expect(await journalLines(companyId, voucherNumber)).toEqual([]);

    await post(["4.00"]);
    await asMaintenance(() => db.transaction((tx) => removeInventoryMovementJournalTx(tx, source())));
    expect(await journalLines(companyId, voucherNumber)).toEqual([]);
    const identity = await pool.query(
      // Wave 16 (A): the retired journal keeps its marker, released ("#retired:").
      `SELECT COUNT(*)::int AS n FROM accounting_posting_requests WHERE company_id = $1 AND source_type = 'perpetual-inventory-movement:quick-adjust' AND position('#retired:' in idempotency_key) = 0`,
      [companyId]
    );
    expect(identity.rows[0].n).toBe(0);
  });

  it("is a no-op for a supplier-partner company", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-10-01', '{}'::jsonb, 'test')`,
      [spCompanyId]
    );
    expect(await post(["9.00"], spCompanyId)).toBeNull();
  });

  it("refuses Inventory or an unknown account as the offset", async () => {
    for (const offsetAccountCode of ["INVENTORY", "NOT_A_REGISTRY_CODE"]) {
      await expect(
        db.transaction((tx) =>
          postInventoryMovementJournalTx(tx, {
            ...source(),
            date: "2026-10-05",
            reference: "x",
            lines: [{ valueDelta: "1" }],
            offsetAccountCode,
            narration: "x",
          })
        )
      ).rejects.toThrow(/offset/);
    }
  });
});

describe("boot DDL", () => {
  it("is idempotent and matches the schema", async () => {
    await ensureInventoryFidelitySchema(pool);
    await ensureInventoryFidelitySchema(pool);
    const { rows } = await pool.query(
      `SELECT table_name, column_name, numeric_precision, numeric_scale, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((column_name = 'value_moved' AND table_name = ANY($1)) OR (table_name = 'inventory' AND column_name = 'average_rate'))
        ORDER BY table_name`,
      [VALUE_MOVED_TABLES]
    );
    expect(rows).toEqual(
      [
        ...VALUE_MOVED_TABLES.map((table) => ({
          table_name: table,
          column_name: "value_moved",
          numeric_precision: 20,
          numeric_scale: 2,
          is_nullable: "YES",
        })),
        {
          table_name: "inventory",
          column_name: "average_rate",
          numeric_precision: 20,
          numeric_scale: 7,
          is_nullable: "NO",
        },
      ].sort((a, b) => a.table_name.localeCompare(b.table_name))
    );
  });
});

describe("admin stock tool refusal", () => {
  it("allows the tool before the cut-over and refuses it with 409 after", async () => {
    const otherCompany = spCompanyId; // has a cut-over from the test above
    expect(await inventoryCutoverRefusal(db, companyId + 1_000_000, "rebuild-inventory")).toBeNull();
    const refusal = await inventoryCutoverRefusal(db, otherCompany, "rebuild-inventory");
    expect(refusal).toEqual({
      status: 409,
      body: {
        code: PERPETUAL_INVENTORY_ACTIVE,
        message: PERPETUAL_INVENTORY_ACTIVE_MESSAGE,
        action: "rebuild-inventory",
        effectiveFrom: "2026-10-01",
      },
    });
    await expect(assertNoInventoryCutoverTx(db, otherCompany, "rebuild-inventory")).rejects.toBeInstanceOf(
      InventoryCutoverRefusalError
    );
    await expect(assertNoInventoryCutoverTx(db, companyId + 1_000_000, "rebuild-inventory")).resolves.toBeUndefined();
  });

  it("has a translated message", async () => {
    const { wave8ReleaseTranslations } = await import("../client/src/i18n/wave8ReleaseTranslations");
    const entry = wave8ReleaseTranslations.find((candidate) => candidate.en === PERPETUAL_INVENTORY_ACTIVE_MESSAGE);
    expect(entry?.ar).toBeTruthy();
    expect(entry?.fr).toBeTruthy();
  });
});
