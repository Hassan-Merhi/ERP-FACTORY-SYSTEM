/**
 * Factory sheets STATUS summary: the cell/column readers accept both the old
 * and the new stored formats; upsertStatusSheet sums the DIFF / WEIGHT
 * columns of the PRODUCTION, STOCK IN and IO sheets, inserts STATUS first
 * (shifting the other sheets) or updates it in place while keeping edited
 * BEFORE values. Sheet names and BEFORE labels match by whole word, so "IO"
 * never reads "PRODUCTION". Runs inside one rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import {
  getCellRawValue,
  getColLabel,
  upsertStatusSheet,
} from "../server/routes/factory/factorySheetsRoutesBuildStatusSheet";
import { withRolledBackPool } from "./helpers/routedPoolClient";

describe("STATUS sheet cell readers", () => {
  it("reads column labels in the old and new formats", () => {
    expect(getColLabel("DIFF")).toBe("DIFF");
    expect(getColLabel({ id: "c1", label: "WEIGHT" })).toBe("WEIGHT");
    expect(getColLabel({ id: "c1", label: 5 })).toBe("");
    expect(getColLabel({ id: "c1" })).toBe("");
    expect(getColLabel(null)).toBe("");
  });

  it("reads cell values in the old and new formats", () => {
    expect(getCellRawValue(null)).toBeNull();
    expect(getCellRawValue(undefined)).toBeNull();
    expect(getCellRawValue(4)).toBe(4);
    expect(getCellRawValue("x")).toBe("x");
    expect(getCellRawValue({ value: 7, link: "l" })).toBe(7);
    expect(getCellRawValue({ value: null })).toBeNull();
    expect(getCellRawValue({ value: true })).toBe("true");
    expect(getCellRawValue({ other: 1 })).toBeNull();
    expect(getCellRawValue(true)).toBeNull();
  });
});

async function company(client: PoolClient) {
  const tag = `FSS${Date.now().toString(36)}`.toUpperCase();
  return (
    await client.query<{ id: number }>(
      `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
      [tag]
    )
  ).rows[0].id;
}

const status = async (client: PoolClient, companyId: number) =>
  (
    await client.query(
      `SELECT id, order_index, columns, rows FROM factory_sheets WHERE company_id = $1 AND name = 'STATUS'`,
      [companyId]
    )
  ).rows;

describe("upsertStatusSheet", () => {
  it("inserts STATUS first from source sheet totals with default BEFORE values", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = await company(client);
      const other = (
        await client.query<{ id: number }>(
          `INSERT INTO factory_sheets (company_id, name, order_index) VALUES ($1, 'Notes', 0) RETURNING id`,
          [companyId]
        )
      ).rows[0].id;
      await upsertStatusSheet(companyId, [
        {
          name: "Production 2026",
          columns: ["Item", { id: "d", label: "diff" }],
          rows: [
            { label: "a", cells: [0, "1,000"] as never },
            { label: "b", cells: [0, { value: -200 }] as never },
            { label: "c", cells: [0, Number.NaN] },
            { label: "d", cells: [0, "abc"] as never },
          ],
        },
        { name: "stock in", columns: ["فرق"], rows: [{ label: "s", cells: [50] }] },
        {
          name: "IO",
          columns: ["Weight"],
          rows: [
            { label: "i", cells: [12] },
            { label: "j", cells: [null] as never },
          ],
        },
        { name: "Unrelated", columns: [], rows: [] },
      ]);
      const [row] = await status(client, companyId);
      expect(row.order_index).toBe(0);
      expect(row.columns).toEqual(["BEFORE", "DIFF", "AFTER"]);
      // Sheet names match by whole word: "IO" reads the IO sheet, not
      // "Production 2026" (prodUCTIOn).
      expect(row.rows.map((r: { cells: number[] }) => r.cells)).toEqual([
        [-183221, -800, -184021],
        [-46020, -50, -46070],
        [-69011, 12, -68999],
        [-298252, -838, -299090],
      ]);
      const shifted = await client.query(`SELECT order_index FROM factory_sheets WHERE id = $1`, [other]);
      expect(shifted.rows[0].order_index).toBe(1);
    });
  });

  it("updates an existing STATUS sheet in place and keeps edited BEFORE values", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = await company(client);
      const id = (
        await client.query<{ id: number }>(
          `INSERT INTO factory_sheets (company_id, name, order_index) VALUES ($1, 'STATUS', 3) RETURNING id`,
          [companyId]
        )
      ).rows[0].id;
      await upsertStatusSheet(companyId, [
        {
          id,
          name: " status ",
          columns: ["BEFORE", "DIFF", "AFTER"],
          rows: [
            { label: "PRODUCTION اجراء اعمال", cells: [-1000, 0, 0] },
            { label: "STOCK IN", cells: [0, 0, 0] },
          ],
        },
        { name: "PRODUCTION", columns: ["Nothing"], rows: [{ label: "x", cells: [5] }] },
      ]);
      const [row] = await status(client, companyId);
      expect(row.id).toBe(id);
      expect(row.order_index).toBe(0);
      // The IO BEFORE lookup no longer takes the "PRODUCTION ..." row's edited
      // value; IO has no row of its own, so it keeps its default.
      expect(row.rows.map((r: { cells: number[] }) => r.cells[0])).toEqual([-1000, -46020, -69011, -116031]);
    });
  });

  it("reads IO and PRODUCTION sheets and BEFORE rows separately in either order", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = await company(client);
      const id = (
        await client.query<{ id: number }>(
          `INSERT INTO factory_sheets (company_id, name) VALUES ($1, 'STATUS') RETURNING id`,
          [companyId]
        )
      ).rows[0].id;
      const statusSheet = (rows: { label: string; cells: number[] }[]) => ({
        id,
        name: "STATUS",
        columns: ["BEFORE", "DIFF", "AFTER"],
        rows,
      });
      const io = { name: "io", columns: ["WEIGHT"], rows: [{ label: "w", cells: [7] }] };
      const production = { name: "PRODUCTION", columns: ["DIFF"], rows: [{ label: "p", cells: [30] }] };
      const ioRow = { label: "IO", cells: [-500, 0, 0] };
      const productionRow = { label: "PRODUCTION اجراء اعمال", cells: [-2000, 0, 0] };
      const expected = [
        [-2000, -30, -2030],
        [-46020, 0, -46020],
        [-500, 7, -493],
        [-48520, -23, -48543],
      ];

      await upsertStatusSheet(companyId, [statusSheet([ioRow, productionRow]), io, production]);
      expect((await status(client, companyId))[0].rows.map((r: { cells: number[] }) => r.cells)).toEqual(expected);
      await upsertStatusSheet(companyId, [statusSheet([productionRow, ioRow]), production, io]);
      expect((await status(client, companyId))[0].rows.map((r: { cells: number[] }) => r.cells)).toEqual(expected);
    });
  });

  it("falls back to default BEFORE values when the existing STATUS has no BEFORE column", async () => {
    await withRolledBackPool(async (client) => {
      const companyId = await company(client);
      const id = (
        await client.query<{ id: number }>(
          `INSERT INTO factory_sheets (company_id, name) VALUES ($1, 'STATUS') RETURNING id`,
          [companyId]
        )
      ).rows[0].id;
      await upsertStatusSheet(companyId, [
        { id, name: "STATUS", columns: ["OTHER"], rows: [{ label: "IO", cells: [9] }] },
      ]);
      const [row] = await status(client, companyId);
      expect(row.rows[2].cells).toEqual([-69011, 0, -69011]);
    });
  });
});
