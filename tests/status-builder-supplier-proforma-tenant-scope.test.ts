/**
 * Child rows reached by id must belong to the active company.
 *
 *   - Status builder: templates and runs carry a company, metrics and values
 *     hang off them. Every route read or wrote by id alone, so another
 *     company's template, metrics, runs and values could be edited.
 *   - Supplier proforma delete removed the proforma's lines before checking
 *     the company, so another company's lines were wiped.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "childscope";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let foreignCompanyId: number;
let templateId: number;
let metricId: number;
let runId: number;
let supplierId: number;
let proformaId: number;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1, $2, 'factory', 'USD') RETURNING id`,
    [`${TEST_PREFIX.toUpperCase()}F`, `${TEST_PREFIX}_Foreign`]
  );
  foreignCompanyId = company.rows[0].id;
  const template = await pool.query<{ id: number }>(
    `INSERT INTO status_report_templates (company_id, name) VALUES ($1, 'Foreign template') RETURNING id`,
    [foreignCompanyId]
  );
  templateId = template.rows[0].id;
  const metric = await pool.query<{ id: number }>(
    `INSERT INTO status_metrics (template_id, name) VALUES ($1, 'Foreign metric') RETURNING id`,
    [templateId]
  );
  metricId = metric.rows[0].id;
  const run = await pool.query<{ id: number }>(
    `INSERT INTO status_report_runs (template_id, company_id, run_date) VALUES ($1, $2, '2026-09-01') RETURNING id`,
    [templateId, foreignCompanyId]
  );
  runId = run.rows[0].id;

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [foreignCompanyId, `${TEST_PREFIX.toUpperCase()}S`, `${TEST_PREFIX} supplier`, `${TEST_PREFIX}@example.test`]
  );
  supplierId = supplier.rows[0].id;
  const proforma = await pool.query<{ id: number }>(
    `INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'FOREIGN-PF') RETURNING id`,
    [foreignCompanyId, supplierId]
  );
  proformaId = proforma.rows[0].id;
  await pool.query(
    `INSERT INTO supplier_proforma_lines (proforma_id, barcode, item_name, qty) VALUES ($1, 'B1', 'Item', 3)`,
    [proformaId]
  );
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM status_metric_values WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM status_report_runs WHERE template_id = $1`, [templateId]);
  await pool.query(`DELETE FROM status_metrics WHERE template_id = $1`, [templateId]);
  await pool.query(`DELETE FROM status_report_templates WHERE id = $1`, [templateId]);
  await pool.query(`DELETE FROM supplier_proforma_lines WHERE proforma_id = $1`, [proformaId]);
  await pool.query(`DELETE FROM supplier_proformas WHERE id = $1`, [proformaId]);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [foreignCompanyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("status builder tenant scope", () => {
  it("refuses another company's template, metrics and runs", async () => {
    const base = "/api/factory/status-builder";
    const responses = await Promise.all([
      agent.patch(`${base}/templates/${templateId}`).send({ name: "Hijacked" }),
      agent.get(`${base}/templates/${templateId}/metrics`),
      agent.post(`${base}/metrics`).send({ templateId, name: "Injected" }),
      agent.patch(`${base}/metrics/${metricId}`).send({ name: "Hijacked" }),
      agent.get(`${base}/run?templateId=${templateId}&date=2026-09-02`),
      agent.post(`${base}/runs/${runId}/refresh`),
      agent
        .patch(`${base}/runs/${runId}/values`)
        .send({ entries: [{ metricId, beforeValue: 1, manualAdjustment: 1 }] }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);

    const remove = await agent.delete(`${base}/metrics/${metricId}`);
    expect(remove.status).toBe(404);

    const template = await pool.query(`SELECT name FROM status_report_templates WHERE id = $1`, [templateId]);
    expect(template.rows[0].name).toBe("Foreign template");
    const metrics = await pool.query(`SELECT name FROM status_metrics WHERE template_id = $1`, [templateId]);
    expect(metrics.rows).toEqual([{ name: "Foreign metric" }]);
  });
});

describe("supplier proforma delete tenant scope", () => {
  it("leaves another company's proforma lines in place", async () => {
    const response = await agent.delete(`/api/suppliers/${supplierId}/proformas/${proformaId}`);
    expect(response.status).toBe(404);
    const lines = await pool.query(`SELECT 1 FROM supplier_proforma_lines WHERE proforma_id = $1`, [proformaId]);
    expect(lines.rowCount).toBe(1);
  });
});
