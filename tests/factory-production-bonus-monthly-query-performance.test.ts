import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const liveSql=readFileSync(
  resolve(process.cwd(),"server/services/factory/targetBonusLivePreview.ts"),"utf8"
);

describe("Production bonus range query: one bale aggregation per month",()=>{
  it("materializes physical production once per worker/day instead of scanning bales for each worker",()=>{
    expect(liveSql).toContain("bale_work_days AS MATERIALIZED");
    expect(liveSql).toContain("credited_bales AS MATERIALIZED");
    // eb06d78 credits each bale to its Stock Entry finalizer: no linked-team totals.
    expect(liveSql).not.toContain("linked_work_totals");
    expect(liveSql).toContain("GROUP BY b.stock_entry_date, b.finalized_by");
    expect(liveSql).toContain("GROUP BY work_date, worker_id");
    expect(liveSql).not.toContain("SELECT COUNT(*)::integer AS bales FROM factory_bales b");
    expect(liveSql).not.toContain("FROM credited_bales bc\n      WHERE bc.work_date = d.work_date");
  });

  it("preserves previous-day carry only for bales created or finalized after the prior closure",()=>{
    expect(liveSql).toContain("JOIN factory_staff_tracking_period_closures c");
    expect(liveSql).toContain("c.period_start = b.stock_entry_date AND c.period_end = b.stock_entry_date");
    expect(liveSql).toContain("COALESCE(b.finalized_at,b.created_at) > c.ended_at");
    expect(liveSql).toContain("SELECT (b.stock_entry_date + 1) AS work_date");
    expect(liveSql).toContain("UNION ALL");
  });

  it("credits personal bales only, never splitting a linked team's bales, and keeps immutable reviews",()=>{
    expect(liveSql).toContain("single_bales.worker_id=w.id");
    expect(liveSql).toContain("SELECT COALESCE(single_bales.bales,0)::integer AS credited");
    expect(liveSql).not.toContain("team_bales");
    expect(liveSql).not.toContain("members.member_count");
    expect(liveSql).toContain("COALESCE(review.produced_bales, credit.credited, 0)");
    expect(liveSql).toContain("COALESCE(review.bonus_amount");
    expect(liveSql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM factory_staff_tracking_period_closures c/);
    expect(liveSql).toContain("factory_staff_tracking_period_closures c");
  });
});
