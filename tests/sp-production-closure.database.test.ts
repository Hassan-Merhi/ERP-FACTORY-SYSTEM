import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  buildSpProductionClosureStatus,
} from "../server/routes/sp/spProductionClosureRoutes";
import { hasTable, tableConstraints } from "./helpers/schemaManifest";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

const requiredChecks = [
  "daily_sales_stock",
  "container_offload_postings",
  "supplier_statement_ledger",
  "sales_form_profit_split",
  "source_write_lock",
  "production_logs",
  "supplier_links",
  "migration_suspense",
] as const;

databaseDescribe("Supplier Partner production closure database", () => {
  it("has the migration-defined evidence and immutable completion tables", async () => {
    expect(hasTable("sp_production_evidence")).toBe(true);
    expect(hasTable("sp_completion_records")).toBe(true);
    expect(tableConstraints("sp_production_evidence")).toContain("UNIQUE (company_id, cutover_id, evidence_type)");
    expect(tableConstraints("sp_completion_records")).toContain("UNIQUE (company_id, cutover_id)");

    const result = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('sp_production_evidence', 'sp_completion_records')
      ORDER BY table_name
    `);

    expect((result as any).rows.map((row: any) => row.table_name)).toEqual([
      "sp_completion_records",
      "sp_production_evidence",
    ]);
  });

  it("enforces company/cutover evidence upsert and immutable completion uniqueness", async () => {
    const companyId = 900000001;
    const cutoverId = 900000001;
    await db.execute(sql`DELETE FROM sp_completion_records WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM sp_production_evidence WHERE company_id = ${companyId}`);

    await db.execute(sql`
      INSERT INTO sp_production_evidence(company_id, cutover_id, evidence_type, status, detail)
      VALUES (${companyId}, ${cutoverId}, 'production_smoke', 'PASS', '{}'::jsonb)
      ON CONFLICT (company_id, cutover_id, evidence_type)
      DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    `);
    await db.execute(sql`
      INSERT INTO sp_production_evidence(company_id, cutover_id, evidence_type, status, detail)
      VALUES (${companyId}, ${cutoverId}, 'production_smoke', 'FAIL', '{}'::jsonb)
      ON CONFLICT (company_id, cutover_id, evidence_type)
      DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    `);

    const evidence = await db.execute(sql`
      SELECT status FROM sp_production_evidence
      WHERE company_id = ${companyId} AND cutover_id = ${cutoverId}
    `);
    expect((evidence as any).rows).toHaveLength(1);
    expect((evidence as any).rows[0].status).toBe("FAIL");

    await db.execute(sql`
      INSERT INTO sp_completion_records(company_id, cutover_id, completion_snapshot, reason)
      VALUES (${companyId}, ${cutoverId}, '{}'::jsonb, 'database test closure')
    `);
    await expect(
      db.execute(sql`
        INSERT INTO sp_completion_records(company_id, cutover_id, completion_snapshot, reason)
        VALUES (${companyId}, ${cutoverId}, '{}'::jsonb, 'duplicate closure')
      `),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    await db.execute(sql`DELETE FROM sp_completion_records WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM sp_production_evidence WHERE company_id = ${companyId}`);
  });

  it("builds a PASS status only from the active cutover and same-company evidence", async () => {
    const sourceCompanyId = 900000011;
    const targetCompanyId = 900000012;
    const otherCompanyId = 900000013;

    await db.execute(sql`
      DELETE FROM sp_completion_records
      WHERE company_id IN (${targetCompanyId}, ${otherCompanyId})
    `);
    await db.execute(sql`
      DELETE FROM sp_production_evidence
      WHERE company_id IN (${targetCompanyId}, ${otherCompanyId})
    `);
    await db.execute(sql`
      DELETE FROM sp_migration_cutovers
      WHERE source_company_id = ${sourceCompanyId}
        OR target_company_id IN (${targetCompanyId}, ${otherCompanyId})
    `);

    const cutoverResult = await db.execute(sql`
      INSERT INTO sp_migration_cutovers(
        source_company_id, target_company_id, status,
        source_company_name, target_company_name, activated_at
      ) VALUES (
        ${sourceCompanyId}, ${targetCompanyId}, 'active',
        'SP closure test source', 'SP closure test target', now()
      )
      RETURNING id
    `);
    const cutoverId = Number((cutoverResult as any).rows[0].id);

    for (const evidenceType of requiredChecks) {
      await db.execute(sql`
        INSERT INTO sp_production_evidence(
          company_id, cutover_id, evidence_type, status, detail
        ) VALUES (
          ${targetCompanyId}, ${cutoverId}, ${evidenceType}, 'PASS', '{}'::jsonb
        )
      `);
      await db.execute(sql`
        INSERT INTO sp_production_evidence(
          company_id, cutover_id, evidence_type, status, detail
        ) VALUES (
          ${otherCompanyId}, ${cutoverId}, ${evidenceType}, 'FAIL', '{}'::jsonb
        )
      `);
    }

    const status = await buildSpProductionClosureStatus(targetCompanyId);
    expect(status.status).toBe("PASS");
    expect(status.failureCount).toBe(0);
    expect(status.checks).toHaveLength(requiredChecks.length);
    expect(status.checks.every((check: any) => check.status === "PASS")).toBe(true);

    await db.execute(sql`DELETE FROM sp_production_evidence WHERE cutover_id = ${cutoverId}`);
    await db.execute(sql`DELETE FROM sp_completion_records WHERE cutover_id = ${cutoverId}`);
    await db.execute(sql`DELETE FROM sp_migration_cutovers WHERE id = ${cutoverId}`);
  });
});

describe("Supplier Partner production closure Phase 7 contract", () => {
  it("registers all routes behind the centralized migration safeguards", async () => {
    const fs = await import("node:fs/promises");
    const routeSource = await fs.readFile("server/routes/sp/spProductionClosureRoutes.ts", "utf8");
    const accessSource = await fs.readFile("server/routes/sp/spAccessControl.ts", "utf8");

    expect(routeSource).toContain('app.get("/api/sp/production/closure-status", requireAuth');
    expect(routeSource).toContain('app.post("/api/sp/production/evidence", requireAuth');
    expect(routeSource).toContain('app.post("/api/sp/production/close-rollback-window", requireAuth');
    expect(routeSource).toContain("target_company_id = ${companyId}");

    expect(accessSource).toContain('path.startsWith("/production/")');
    expect(accessSource).toContain('return "sp_migration"');
    expect(accessSource).toContain("RECORD SP PRODUCTION EVIDENCE");
    expect(accessSource).toContain("CLOSE SP ROLLBACK WINDOW");
    expect(accessSource).toContain("sp_idempotency_keys");
    expect(accessSource).toContain("sp_audit_events");
  });
});
