import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ensureFactoryTargetBonusPaymentSchema } from "./ensureFactoryTargetBonusPaymentSchema";

describe("Phase 15 one-time weekly bonus payout schema",()=>{
  it("creates a separate unique one-time claim that survives reversal",async()=>{
    const statements:string[]=[];
    const pool={query:async(s:string)=>{statements.push(s);return {rows:[]};}} as unknown as Pick<Pool,"query">;
    await ensureFactoryTargetBonusPaymentSchema(pool);
    const weekly=statements.find(s=>s.includes("CREATE TABLE IF NOT EXISTS factory_target_bonus_weekly_payments"));
    expect(weekly).toBeDefined();
    expect(weekly).toContain("UNIQUE (company_id, review_id)");
    expect(weekly).toContain("UNIQUE (company_id, week_start, worker_id)");
    expect(weekly).toContain("UNIQUE (payment_voucher_id)");
    expect(weekly).toContain("status IN ('POSTED','REVERSED')");
    expect(weekly).toContain("reversal_voucher_id IS NOT NULL");
    expect(weekly).toContain("REFERENCES factory_target_bonus_weekly_reviews(id) ON DELETE RESTRICT");
    expect(statements.some(s=>s.includes("factory_bonus_weekly_payments_date_idx"))).toBe(true);
  });
});
