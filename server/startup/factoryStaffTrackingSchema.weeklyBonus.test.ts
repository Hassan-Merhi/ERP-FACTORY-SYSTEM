import { describe, expect, it } from "vitest";
import { ensureFactoryStaffTrackingSchema } from "./factoryStaffTrackingSchema";

describe("Phase 14 weekly bonus schema startup", () => {
  it("ensures method and immutable weekly review tables even without optional migrations", async () => {
    const statements: string[] = [];
    await ensureFactoryStaffTrackingSchema({
      query: async statement => { statements.push(statement); },
    });
    const method = statements.find(sql => sql.includes(
      "CREATE TABLE IF NOT EXISTS factory_production_target_bonus_weekly_methods"
    ));
    const weekly = statements.find(sql => sql.includes(
      "CREATE TABLE IF NOT EXISTS factory_target_bonus_weekly_reviews"
    ));
    expect(method).toBeDefined();
    expect(weekly).toBeDefined();
    expect(statements.indexOf(method!)).toBeLessThan(statements.indexOf(weekly!));
    expect(weekly).toContain("UNIQUE (company_id, week_start, worker_id)");
    expect(weekly).toContain("REFERENCES factory_production_target_bonus_weekly_methods(id)");
  });

  it("registers immutable review triggers and proper PostgreSQL quoted blocks", async () => {
    const statements: string[] = [];
    await ensureFactoryStaffTrackingSchema({
      query: async statement => { statements.push(statement); },
    });
    const method = statements.find(sql => sql.includes("factory_bonus_weekly_method_immutable"))!;
    const weekly = statements.find(sql => sql.includes("factory_bonus_weekly_review_immutable"))!;
    expect(method).toContain("LANGUAGE plpgsql AS $bonus_method_fn$");
    expect(method).toContain("DO $bonus_method_block$");
    expect(weekly).toContain("LANGUAGE plpgsql AS $weekly_review_fn$");
    expect(weekly).toContain("DO $weekly_review_block$");
    expect(weekly).toContain("BEFORE UPDATE OR DELETE ON factory_target_bonus_weekly_reviews");
    expect(weekly).toContain("snapshot_hash ~ '^[a-f0-9]{64}$'");
  });
});
