/**
 * ERP-company fixtures for the Item Market Analysis route suites, built on the
 * rolled-back factory world (see rolledBackFactoryApp).
 */
import { withFactoryWorld, type FactoryWorld } from "./rolledBackFactoryApp";
import { nextSeq } from "./voucherReadFixture";

/** The factory world with its company switched to an ERP company. */
export async function erpWorld(work: (w: FactoryWorld) => Promise<void>) {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'erp' WHERE id = $1`, [w.companyId]);
    await work(w);
  });
}

/** A second company with one location; the world's user gets `role` there when given. */
export async function secondCompany(w: FactoryWorld, role: string | null, type = "erp") {
  const code = `${w.tag}C${nextSeq()}`.slice(0, 20);
  const id = await w.one(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, $2) RETURNING id`,
    [code, type]
  );
  await w.q(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other yard')`, [id, `${code}L`]);
  if (role) {
    await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [w.userId, id, role]);
  }
  return id;
}

/** Turns Sales Report access off for `role` in `companyId`. */
export const denySalesReport = (w: FactoryWorld, companyId: number, role: string) =>
  w.q(
    `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled)
     VALUES ($1, $2, 'page_sales_report', false) ON CONFLICT DO NOTHING`,
    [companyId, role]
  );
