/**
 * Permanent company deletion (server/storage/company-deletion.ts) inside a
 * rolled-back transaction: id validation, the forced history-deletion guards
 * (still active, wrong confirmation code), a confirmed forced deletion with
 * its audit row, child companies detached instead of deleted, another
 * company's nullable references detached, and another company's mandatory
 * references blocking the delete with nothing removed.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { deleteCompany } from "../server/storage/company-deletion";

let seq = 0;

async function world(fw: FactoryWorld) {
  const tag = `CDG${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase();
  const q = fw.q;
  const id = fw.one;
  const company = (suffix: string, active = true) =>
    id(`INSERT INTO companies (code, name, active) VALUES ($1::varchar, $1::text, $2) RETURNING id`, [
      `${tag}${suffix}`,
      active,
    ]);
  const ledger = (companyId: number, code: string) =>
    id(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Asset') RETURNING id`,
      [companyId, `${tag}-${code}`]
    );
  const voucher = (companyId: number) =>
    id(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Journal', '2026-01-01', '0') RETURNING id`,
      [companyId, `${tag}-V${++seq}`]
    );
  const exists = async (companyId: number) =>
    (await q(`SELECT 1 FROM companies WHERE id = $1`, [companyId])).length === 1;
  return { tag, q, id, company, ledger, voucher, exists };
}

const failure = (work: Promise<unknown>) =>
  work.then(
    () => "deleted",
    (error: Error) => error.message
  );

describe("deleteCompany guards", () => {
  it("rejects ids that are not positive integers", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(await failure(deleteCompany(bad))).toBe("Company ID must be a positive integer.");
    }
  });

  it("requires a deactivated company and its exact code before deleting history", () =>
    withFactoryWorld(async (fw) => {
      const w = await world(fw);
      const target = await w.company("A");
      await w.voucher(target);
      const force = {
        forceDeleteWithHistory: true,
        confirmedCompanyCode: `${w.tag}A`,
        userId: "u-9",
        username: "root",
      };
      expect(await failure(deleteCompany(target, force))).toBe(
        "Deactivate this company before permanently deleting its history."
      );
      await w.q(`UPDATE companies SET active = false WHERE id = $1`, [target]);
      expect(await failure(deleteCompany(target, { ...force, confirmedCompanyCode: "WRONG" }))).toMatch(
        /exact company code/
      );
      expect(await failure(deleteCompany(target, { ...force, confirmedCompanyCode: undefined }))).toMatch(
        /exact company code/
      );
      expect(await w.exists(target)).toBe(true);

      await deleteCompany(target, force);
      expect(await w.exists(target)).toBe(false);
      const [audit] = await w.q(
        `SELECT user_id, username, record_identifier, changes FROM audit_log
          WHERE company_id = $1 AND table_name = 'companies' AND action = 'delete'`,
        [target]
      );
      expect(audit).toMatchObject({ user_id: "u-9", username: "root", record_identifier: `${w.tag}A` });
      expect(audit.changes.forcedHistoryDeletion).toEqual({ new: true });
    }));
});

describe("deleteCompany references", () => {
  it("detaches child companies and other companies' nullable references", () =>
    withFactoryWorld(async (fw) => {
      const w = await world(fw);
      const target = await w.company("P");
      const child = await w.company("C");
      await w.q(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [target, child]);
      const targetLocation = await w.id(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Yard') RETURNING id`,
        [target, `${w.tag}-LOC`]
      );
      const otherEmployee = await w.id(
        `INSERT INTO employees (company_id, code, first_name, last_name, join_date, sales_bonus_pct_location_id)
         VALUES ($1, $2, 'Ada', 'K', '2026-01-01', $3) RETURNING id`,
        [child, `${w.tag}-EM`, targetLocation]
      );

      await deleteCompany(target);
      expect(await w.exists(target)).toBe(false);
      expect(await w.exists(child)).toBe(true);
      const [childRow] = await w.q(`SELECT parent_company_id FROM companies WHERE id = $1`, [child]);
      expect(childRow.parent_company_id).toBeNull();
      const [employee] = await w.q(`SELECT sales_bonus_pct_location_id FROM employees WHERE id = $1`, [otherEmployee]);
      expect(employee.sales_bonus_pct_location_id).toBeNull();
      const [audit] = await w.q(
        `SELECT username, changes FROM audit_log WHERE company_id = $1 AND table_name = 'companies'`,
        [target]
      );
      expect(audit.username).toBe("system");
      expect(audit.changes.forcedHistoryDeletion).toEqual({ new: false });
    }));

  it("refuses when another company's mandatory row points at the company's data", () =>
    withFactoryWorld(async (fw) => {
      const w = await world(fw);
      const target = await w.company("T");
      const other = await w.company("O");
      const targetLocation = await w.id(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Yard') RETURNING id`,
        [target, `${w.tag}-LOC`]
      );
      const item = await w.id(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bale', 'kg') RETURNING id`,
        [other, `${w.tag}-SI`]
      );
      await w.q(`INSERT INTO inventory (company_id, location_id, stock_item_id) VALUES ($1, $2, $3)`, [
        other,
        targetLocation,
        item,
      ]);
      const message = await failure(deleteCompany(target));
      expect(message).toMatch(/Company deletion is blocked/);
      expect(message).toMatch(/No data was deleted/);
      expect(await w.exists(target)).toBe(true);
    }));
});
