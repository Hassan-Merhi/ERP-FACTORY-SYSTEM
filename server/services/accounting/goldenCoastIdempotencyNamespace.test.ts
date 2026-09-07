/**
 * Golden Coast Phase 16 — no duplicate journals.
 *
 * `accounting_posting_requests` carries a unique index on
 * (company_id, idempotency_key), so a repeated key is a replay that returns the
 * original voucher and a fresh key posts a new one. Two failures follow from
 * that, and neither is visible to a single phase's own tests:
 *
 *   * two DIFFERENT events sharing a key — the second silently replays the
 *     first and its journal is never posted, and
 *   * one event producing an UNSTABLE key — a retry posts a duplicate journal.
 *
 * This suite drives every Golden Coast key builder together and checks both
 * properties across the whole programme namespace.
 */
import { describe, expect, it } from "vitest";
import { goldenCoastEquitySalesCashIdempotencyKey } from "./goldenCoastEquitySalesCashSettlement";
import { goldenCoastPhase5IdempotencyKey } from "./goldenCoastPhase5PosSale";
import { goldenCoastPhase6IdempotencyKey } from "./goldenCoastPhase6SpecialLocationDeduction";
import { goldenCoastPhase7IdempotencyKey } from "./goldenCoastPhase7HadiTransfer";
import { goldenCoastPhase9IdempotencyKey } from "./goldenCoastPhase9HassanSavingsWithdrawal";
import { goldenCoastPhase10IdempotencyKey } from "./goldenCoastPhase10SalesCashSettlement";
import { goldenCoastPhase11IdempotencyKey } from "./goldenCoastPhase11MonthlyClose";

const COMPANY = 7;
const OTHER_COMPANY = 8;
const REQUEST = "shared-request-id";

/**
 * Every key the programme can mint for one company from a single shared client
 * request id — the worst case for a namespace collision, because the only thing
 * distinguishing these events is the phase and role encoded in the key itself.
 */
function keysForOneCompany(companyId: number, requestId: string): Record<string, string> {
  return {
    "phase5:revenue": goldenCoastPhase5IdempotencyKey(companyId, requestId, "revenue"),
    "phase5:cogs": goldenCoastPhase5IdempotencyKey(companyId, requestId, "cogs"),
    "phase6:deduction": goldenCoastPhase6IdempotencyKey(companyId, requestId),
    "phase7:golden_coast": goldenCoastPhase7IdempotencyKey(companyId, requestId, "golden_coast"),
    "phase7:hadi": goldenCoastPhase7IdempotencyKey(companyId, requestId, "hadi"),
    "phase9:withdrawal": goldenCoastPhase9IdempotencyKey(companyId, requestId),
    "phase10:settlement": goldenCoastPhase10IdempotencyKey(companyId, requestId),
    "phase11:close": goldenCoastPhase11IdempotencyKey(companyId, "2026-09"),
    "equity-sales-cash:settlement": goldenCoastEquitySalesCashIdempotencyKey(companyId, requestId),
  };
}

describe("Golden Coast idempotency namespace", () => {
  it("gives every distinct event its own key, even from one shared request id", () => {
    const keys = keysForOneCompany(COMPANY, REQUEST);
    const values = Object.values(keys);
    const duplicates = values.filter((value, index) => values.indexOf(value) !== index);

    expect(duplicates).toEqual([]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("separates the two vouchers of a multi-role posting", () => {
    // A phase that posts a pair must not let one leg replay as the other; that
    // would leave the pair half-posted and the two books out of balance.
    expect(goldenCoastPhase5IdempotencyKey(COMPANY, REQUEST, "revenue")).not.toBe(
      goldenCoastPhase5IdempotencyKey(COMPANY, REQUEST, "cogs")
    );
    expect(goldenCoastPhase7IdempotencyKey(COMPANY, REQUEST, "golden_coast")).not.toBe(
      goldenCoastPhase7IdempotencyKey(COMPANY, REQUEST, "hadi")
    );
  });

  it("keeps one company's keys out of another's", () => {
    const mine = keysForOneCompany(COMPANY, REQUEST);
    const theirs = keysForOneCompany(OTHER_COMPANY, REQUEST);

    for (const label of Object.keys(mine)) {
      expect(mine[label]).not.toBe(theirs[label]);
    }
    // Belt and braces: the unique index is scoped by company, but the keys are
    // independently distinct so a mis-scoped query cannot collide either.
    expect(new Set([...Object.values(mine), ...Object.values(theirs)]).size).toBe(
      Object.keys(mine).length + Object.keys(theirs).length
    );
  });

  it("is stable across calls so a retry replays instead of posting twice", () => {
    const first = keysForOneCompany(COMPANY, REQUEST);
    const second = keysForOneCompany(COMPANY, REQUEST);
    expect(second).toEqual(first);
  });

  it("changes with the request id so a genuinely new event posts its own journal", () => {
    const first = keysForOneCompany(COMPANY, "request-a");
    const second = keysForOneCompany(COMPANY, "request-b");

    for (const label of Object.keys(first)) {
      // The monthly close is keyed by period, not request id: one close a month
      // is the point, so it deliberately does not vary here.
      if (label === "phase11:close") {
        expect(second[label]).toBe(first[label]);
        continue;
      }
      expect(second[label]).not.toBe(first[label]);
    }
  });

  it("keys the monthly close by period so a month can only be closed once", () => {
    expect(goldenCoastPhase11IdempotencyKey(COMPANY, "2026-09")).toBe(
      goldenCoastPhase11IdempotencyKey(COMPANY, "2026-09")
    );
    expect(goldenCoastPhase11IdempotencyKey(COMPANY, "2026-09")).not.toBe(
      goldenCoastPhase11IdempotencyKey(COMPANY, "2026-10")
    );
  });

  it("prefixes every key with its own source type", () => {
    // The prefix is what keeps one phase's namespace out of another's; a key
    // that lost it could collide with any other phase using the same request id.
    for (const [label, key] of Object.entries(keysForOneCompany(COMPANY, REQUEST))) {
      const phase = label.split(":")[0];
      expect(key).toMatch(new RegExp(`^golden-coast-${phase}[:-]`));
      expect(key).toContain(`:${COMPANY}:`);
    }
  });
});
