/**
 * Phase 10: prove Excel appearance survives a real PostgreSQL round trip
 * without ever reading or overwriting another company.
 *
 * Deliberately refuses to run outside an isolated localhost test database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import {
  canManageExcelAppearance,
  excelAppearanceSettingKey,
  loadCompanyExcelAppearance,
  saveCompanyExcelAppearance,
} from "../server/services/excelAppearanceSettings";
import { DEFAULT_EXCEL_APPEARANCE_SETTINGS } from "../shared/universal-excel/appearanceSettings";

const companyA = 989000111;
const companyB = 989000112;
const keys = [excelAppearanceSettingKey(companyA), excelAppearanceSettingKey(companyB)];

function assertIsolatedTestDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== "test" || !url) throw new Error("Isolated test DB required");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || parsed.pathname !== "/heliumdb") {
    throw new Error("Excel appearance tests may only modify localhost /heliumdb");
  }
}

beforeAll(async () => {
  assertIsolatedTestDatabase();
  await pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])", [keys]);
});
afterAll(async () => {
  assertIsolatedTestDatabase();
  await pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])", [keys]);
});

describe("Phase 10 real database Excel appearance isolation", () => {
  it("uses independent per-company records and default when absent", async () => {
    expect(await loadCompanyExcelAppearance(companyA)).toEqual(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    expect(await loadCompanyExcelAppearance(companyB)).toEqual(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    expect(excelAppearanceSettingKey(companyA)).not.toBe(excelAppearanceSettingKey(companyB));
  });

  it("persists an Admin saved brand and a different Developer saved brand without leakage", async () => {
    const a = { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, brandName: "DAKZO A", accentColor: "#123456" };
    const b = { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, brandName: "DAKZO B", accentColor: "#654321" };
    expect(await saveCompanyExcelAppearance(companyA, a)).toEqual(a);
    expect(await saveCompanyExcelAppearance(companyB, b)).toEqual(b);
    expect(await loadCompanyExcelAppearance(companyA)).toEqual(a);
    expect(await loadCompanyExcelAppearance(companyB)).toEqual(b);
    expect(canManageExcelAppearance("Admin")).toBe(true);
    expect(canManageExcelAppearance("Developer")).toBe(true);
    for (const denied of ["Owner", "POS", "View Only", "ERP Tester", "Normal User", null, undefined]) {
      expect(canManageExcelAppearance(denied)).toBe(false);
    }
  });

  it("updates one company in place and preserves the other company unchanged", async () => {
    const next = {
      ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      brandName: "DAKZO A NEW",
      showCompanyName: false,
      alternateRows: false,
      headerText: "PRIVATE REPORT",
    };
    await saveCompanyExcelAppearance(companyA, next);
    expect(await loadCompanyExcelAppearance(companyA)).toEqual(next);
    expect((await loadCompanyExcelAppearance(companyB)).brandName).toBe("DAKZO B");
    const res = await pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM system_settings WHERE key = ANY($1::text[]) ORDER BY key",
      [keys]
    );
    expect(res.rows).toHaveLength(2);
    expect(JSON.parse(res.rows[0].value)).toMatchObject({ brandName: "DAKZO A NEW" });
  });

  it("rejects malicious/invalid saved configuration before writing any row", async () => {
    const original = await loadCompanyExcelAppearance(companyA);
    await expect(
      saveCompanyExcelAppearance(companyA, {
        ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
        logoDataUrl: "https://tracking.example/a.png",
      })
    ).rejects.toThrow();
    expect(await loadCompanyExcelAppearance(companyA)).toEqual(original);
  });

  it("recovers safely from an invalid stored value without inventing company settings", async () => {
    await pool.query("UPDATE system_settings SET value=$1 WHERE key=$2", ["{bad", keys[0]]);
    expect(await loadCompanyExcelAppearance(companyA)).toEqual(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    // Restore valid data before cleanup; unaffected B must still retain its own brand.
    await saveCompanyExcelAppearance(companyA, DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    expect((await loadCompanyExcelAppearance(companyB)).brandName).toBe("DAKZO B");
  });
});
