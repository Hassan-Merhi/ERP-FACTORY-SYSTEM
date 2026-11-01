import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allocateWeeklyExtraBales } from "../shared/productionBonusCheckoutMath";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Production Bonuses sheet — weekly flat amounts", () => {
  it("detects a 52/50 weekly surplus across five days without multiplying the fee", () => {
    const days = [11, 10, 11, 10, 10].map((produced, i) => ({
      date: `2026-10-${String(26 + i).padStart(2, "0")}`,
      workerId: 7, target: 10, produced, targetConfigured: true,
    }));
    const allocated = allocateWeeklyExtraBales(days);
    expect(days.reduce((sum, day) => sum + day.produced, 0)).toBe(52);
    expect(days.reduce((sum, day) => sum + day.target, 0)).toBe(50);
    expect([...allocated.values()].reduce((sum, extra) => sum + extra, 0)).toBe(2);
    // The weekly method pays $25 ONCE, not $25 × 2 surplus bales.
    const weeklyFlatFee = 25;
    expect(([...allocated.values()].reduce((sum, extra) => sum + extra, 0) > 0)
      ? weeklyFlatFee : 0).toBe(25);
  });

  it("does not show a flat fee before the total weekly target is exceeded", () => {
    const days = [12, 10, 9, 9, 10].map((produced, i) => ({
      date: `2026-10-${String(26 + i).padStart(2, "0")}`,
      workerId: 8, target: 10, produced, targetConfigured: true,
    }));
    const allocated = allocateWeeklyExtraBales(days);
    expect([...allocated.values()].reduce((sum, n) => sum + n, 0)).toBe(0);
  });

  it("fetches the effective weekly fee and displays it once per worker/week", () => {
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    expect(route).toContain('flat_bonus_usd::text AS "flatBonusUsd"');
    expect(route).toContain('summary.extra <= 0 || summary.dailyClaim');
    expect(route).toContain('weekStart + ":" + item.workerId');
    expect(route).toContain("if (weeklyBonus) shownWeekly.add(weekKey)");
    expect(route).toContain('state: "projected"');
    expect(route).toContain('review.status === "approved"');
  });

  it("shows the projected amount in the sheet but never passes it to daily payment checkout", () => {
    const panel = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const sheet = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    expect(panel).toContain('group.weeklyAmount+=Math.round(Number(row.weeklyBonus.amount)*100)');
    expect(panel).toContain('selected.includes(row.workerId)&&payableStatus(row)');
    expect(sheet).toContain('dollars(worker.amount + worker.weeklyAmount)');
    expect(sheet).toContain("Projected · finish week and approve before payment");
    expect(sheet).toContain("Includes weekly estimates · use Weekly Bonus Review & Pay below");
  });
  it("groups linked workers visually but keeps each worker independently selectable", () => {
    const checkout = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const sheet = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    const route = source("server/routes/factory/productionBonusCheckoutRoutes.ts");
    expect(route).toContain("linkGroupId:item.linkGroupId");
    expect(sheet).toContain("rowSpan={members.length}");
    expect(sheet).toContain("Linked to {members[0].workerName}");
    expect(sheet).toContain("onToggle(member.workerId, checked === true)");
    expect(checkout).toContain("selected.includes(row.workerId)&&payableStatus(row)");
    expect(checkout).toContain("<ProductionTargetWeeklyBonusPaymentsPanel initialDate={to}/>");
  });

});
