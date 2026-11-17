/**
 * Phase 14/15 weekly bonus schema. These guarantees used to be asserted against
 * the runtime DDL in server/startup/factoryStaffTrackingSchema.ts and
 * ensureFactoryTargetBonusPaymentSchema.ts; the schema now comes only from
 * migrations, so they are asserted against the committed schema manifest.
 */
import { describe, expect, it } from "vitest";

import { functionDefinition, hasIndex, hasTable, tableConstraints, triggerDefinition } from "./helpers/schemaManifest";

describe("Phase 14 weekly bonus method and review schema", () => {
  it("defines method versions and immutable weekly reviews, one per worker and week", () => {
    expect(hasTable("factory_production_target_bonus_weekly_methods")).toBe(true);
    expect(hasTable("factory_target_bonus_weekly_reviews")).toBe(true);
    const review = tableConstraints("factory_target_bonus_weekly_reviews");
    expect(review).toContain("UNIQUE (company_id, week_start, worker_id)");
    expect(review).toContain(
      "FOREIGN KEY (method_version_id) REFERENCES factory_production_target_bonus_weekly_methods(id) ON DELETE RESTRICT"
    );
    expect(review).toContain("CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'::text)");
  });

  it("blocks UPDATE and DELETE of method versions and reviews with row triggers", () => {
    expect(triggerDefinition("factory_production_target_bonus_weekly_methods", "factory_bonus_weekly_method_immutable")).toBe(
      "CREATE TRIGGER factory_bonus_weekly_method_immutable BEFORE DELETE OR UPDATE ON public.factory_production_target_bonus_weekly_methods FOR EACH ROW EXECUTE FUNCTION prevent_bonus_weekly_method_mutation()"
    );
    expect(triggerDefinition("factory_target_bonus_weekly_reviews", "factory_bonus_weekly_review_immutable")).toBe(
      "CREATE TRIGGER factory_bonus_weekly_review_immutable BEFORE DELETE OR UPDATE ON public.factory_target_bonus_weekly_reviews FOR EACH ROW EXECUTE FUNCTION prevent_weekly_bonus_review_mutation()"
    );
    expect(functionDefinition("prevent_bonus_weekly_method_mutation")).toContain(
      "RAISE EXCEPTION 'Production bonus weekly method versions are immutable'"
    );
    expect(functionDefinition("prevent_weekly_bonus_review_mutation")).toContain(
      "RAISE EXCEPTION 'Production bonus weekly reviews are immutable'"
    );
  });
});

describe("Phase 15 one-time weekly bonus payout schema", () => {
  it("creates a separate unique one-time claim that survives reversal", () => {
    expect(hasTable("factory_target_bonus_weekly_payments")).toBe(true);
    const payment = tableConstraints("factory_target_bonus_weekly_payments");
    expect(payment).toContain("UNIQUE (company_id, review_id)");
    expect(payment).toContain("UNIQUE (company_id, week_start, worker_id)");
    expect(payment).toContain("UNIQUE (payment_voucher_id)");
    expect(payment).toContain(
      "CHECK (status::text = ANY (ARRAY['POSTED'::character varying::text, 'REVERSED'::character varying::text]))"
    );
    expect(payment).toContain(
      "CHECK (status::text = 'POSTED'::text AND reversal_voucher_id IS NULL AND reversed_at IS NULL OR status::text = 'REVERSED'::text AND reversal_voucher_id IS NOT NULL AND reversed_at IS NOT NULL)"
    );
    expect(payment).toContain(
      "FOREIGN KEY (review_id) REFERENCES factory_target_bonus_weekly_reviews(id) ON DELETE RESTRICT"
    );
    expect(hasIndex("factory_bonus_weekly_payments_date_idx")).toBe(true);
  });
});
