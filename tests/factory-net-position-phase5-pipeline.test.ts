/**
 * Phase 5 Net Position historical pipeline acceptance cases.
 * Authored only; execution is explicitly deferred to Claude.
 */
import { describe, it, expect } from "vitest";
import { historicalContainerOtw, orderStageAt } from "../server/services/factory/netPositionHistoricalPipeline";

describe("Historical order status cutoffs", () => {
  it("never counts a not-yet-created future order", () => {
    expect(
      orderStageAt({
        created: false,
        loadingStarted: true,
        verified: true,
        invoiced: false,
        currentStatus: "VERIFIED",
      })
    ).toBe("UNKNOWN");
  });

  it("keeps an Oct 19 LOADING order despite it being verified on Oct 21", () => {
    expect(
      orderStageAt({
        created: true,
        loadingStarted: true,
        verified: false,
        invoiced: false,
        currentStatus: "FINALIZED",
      })
    ).toBe("LOADING");
  });

  it("distinguishes verified and finalized cutoffs without trusting current status", () => {
    expect(
      orderStageAt({
        created: true,
        loadingStarted: true,
        verified: true,
        invoiced: false,
        currentStatus: "FINALIZED",
        loadingStartedAt: "2026-10-18 08:00:00",
        verifiedAt: "2026-10-19 12:00:00",
      })
    ).toBe("VERIFIED");
    expect(
      orderStageAt({
        created: true,
        loadingStarted: true,
        verified: true,
        invoiced: true,
        currentStatus: "FINALIZED",
      })
    ).toBe("FINALIZED");
  });

  it("reopened LOADING overrides an earlier VERIFIED timestamp", () => {
    const common = {
      created: true,
      loadingStarted: true,
      verified: true,
      invoiced: false,
      currentStatus: "VERIFIED",
      loadingStartedAt: "2026-10-20 09:00:00",
    };
    expect(
      orderStageAt({
        ...common,
        verifiedAt: "2026-10-19 10:00:00",
      })
    ).toBe("LOADING");
    expect(
      orderStageAt({
        ...common,
        verifiedAt: "2026-10-21 11:00:00",
      })
    ).toBe("VERIFIED");
  });

  it("requires evidence that a pending status already existed on the selected date", () => {
    expect(
      orderStageAt({
        created: true,
        loadingStarted: false,
        verified: false,
        invoiced: false,
        currentStatus: "PENDING_VERIFICATION",
        currentStateKnown: false,
      })
    ).toBe("UNKNOWN");
    expect(
      orderStageAt({
        created: true,
        loadingStarted: false,
        verified: false,
        invoiced: false,
        currentStatus: "PENDING_VERIFICATION",
        currentStateKnown: true,
      })
    ).toBe("PENDING_VERIFICATION");
  });

  it("refuses to infer missing transitions from today's verified status", () => {
    expect(
      orderStageAt({
        created: true,
        loadingStarted: false,
        verified: false,
        invoiced: false,
        currentStatus: "VERIFIED",
      })
    ).toBe("UNKNOWN");
  });
});

describe("Historical factory OTW follows today's container status rule", () => {
  const base = {
    status: "IN_TRANSIT",
    preOffloadStatus: null,
    receivedByCutoff: false,
    updatedAfterCutoff: false,
    currencyCode: "USD",
    totalKg: "10000",
    ratePerKg: "0.5",
    finalPayable: "0",
    freight: "300",
    freightCurrencyCode: "USD",
    commission: "0",
    commissionCurrencyCode: "USD",
    otherCharges: "0",
    preOffloadFreight: null,
    preOffloadFreightCurrencyCode: null,
    preOffloadCommission: null,
    preOffloadCommissionCurrencyCode: null,
    preOffloadOtherCharges: null,
  };
  const usd = (r: ReturnType<typeof historicalContainerOtw>) =>
    (r?.amounts ?? []).reduce((s, a) => s + a.amount.toNumber(), 0);

  it("values an in-transit container exactly as today's report: final payable, else rate x kg, plus charges", () => {
    expect(usd(historicalContainerOtw(base))).toBe(5300);
    expect(usd(historicalContainerOtw({ ...base, finalPayable: "4800" }))).toBe(5100);
  });

  it("removes the whole container from OTW once a receipt is known by the cutoff (no remaining-kg share)", () => {
    // 10,000 kg container, 4,000 kg received Oct 20: today's rule moves it to
    // PARTIALLY_RECEIVED and stops counting it as OTW; the supplier payable
    // and raw stock take over. Historical dates follow the same rule.
    expect(
      historicalContainerOtw({
        ...base,
        status: "PARTIALLY_RECEIVED",
        preOffloadStatus: "ARRIVED",
        receivedByCutoff: true,
      })
    ).toBeNull();
  });

  it("keeps a container offloaded after the cutoff in transit, using its pre-offload charges, not the offload's", () => {
    const r = historicalContainerOtw({
      ...base,
      status: "OFFLOADED",
      preOffloadStatus: "ARRIVED",
      updatedAfterCutoff: true,
      finalPayable: "2000",
      freight: "999",
      preOffloadFreight: "300",
      preOffloadFreightCurrencyCode: "USD",
      preOffloadCommission: "0",
      preOffloadOtherCharges: "0",
    });
    expect(usd(r)).toBe(5300);
    expect(r?.warnings).toContain("HISTORICAL_OTW_MASTER_VALUES_UNVERSIONED");
  });

  it("never counts an opening-balance container or one that was not in transit before offload", () => {
    expect(historicalContainerOtw({ ...base, status: "OPENING_BALANCE" })).toBeNull();
    expect(historicalContainerOtw({ ...base, status: "OFFLOADED", preOffloadStatus: "OPENING_BALANCE" })).toBeNull();
  });

  it("flags, rather than hides, a non-transit status edited after the cutoff", () => {
    const r = historicalContainerOtw({ ...base, status: "OPENING_BALANCE", updatedAfterCutoff: true });
    expect(r?.amounts).toEqual([]);
    expect(r?.warnings).toEqual(["HISTORICAL_OTW_STATUS_HISTORY_MISSING"]);
  });
});
