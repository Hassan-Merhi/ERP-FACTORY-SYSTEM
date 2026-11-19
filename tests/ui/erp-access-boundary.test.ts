import { describe, expect, it } from "vitest";

import {
  ERP_ACCESS_BOUNDARY_STATE,
  isRecoverableErpAccessRefreshError,
  resolveErpAccessBoundaryState,
} from "../../client/src/app/ErpAccessBoundary";

describe("ERP access boundary", () => {
  it("keeps the ERP shell closed until a user and company are available", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: false,
        companyId: null,
        hasAccessData: false,
        hasQueryError: false,
        synchronizedCompanyId: null,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.loading);
  });

  it("fails closed when the page-access request fails", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: true,
        companyId: 12,
        hasAccessData: false,
        hasQueryError: true,
        synchronizedCompanyId: null,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.error);
  });

  it("keeps the verified ERP workspace mounted after a transient access refetch failure", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: true,
        companyId: 12,
        hasAccessData: true,
        hasQueryError: true,
        hasRecoverableQueryError: true,
        synchronizedCompanyId: 12,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.ready);
  });

  it("never reuses another company's grant or unverified access after a transient failure", () => {
    for (const [hasAccessData, synchronizedCompanyId] of [
      [false, null],
      [true, 7],
    ] as const) {
      expect(
        resolveErpAccessBoundaryState({
          hasUser: true,
          companyId: 12,
          hasAccessData,
          hasQueryError: true,
          hasRecoverableQueryError: true,
          synchronizedCompanyId,
        })
      ).toBe(ERP_ACCESS_BOUNDARY_STATE.error);
    }
  });

  it("fails closed on a new authorization denial even if a grant was cached", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: true,
        companyId: 12,
        hasAccessData: true,
        hasQueryError: true,
        hasRecoverableQueryError: false,
        synchronizedCompanyId: 12,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.error);
  });

  it("does not mount the router or sidebar with permissions from another company", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: true,
        companyId: 12,
        hasAccessData: true,
        hasQueryError: false,
        synchronizedCompanyId: 7,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.loading);
  });

  it("opens the ERP shell only after the current company permissions are synchronized", () => {
    expect(
      resolveErpAccessBoundaryState({
        hasUser: true,
        companyId: 12,
        hasAccessData: true,
        hasQueryError: false,
        synchronizedCompanyId: 12,
      })
    ).toBe(ERP_ACCESS_BOUNDARY_STATE.ready);
  });
  it("only recovers from transport, throttling, timeout, or server errors", () => {
    const withStatus = (status: number) => Object.assign(new Error("Access check failed"), { status });
    for (const status of [408, 429, 500, 502, 503]) {
      expect(isRecoverableErpAccessRefreshError(withStatus(status))).toBe(true);
    }
    expect(isRecoverableErpAccessRefreshError(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRecoverableErpAccessRefreshError(withStatus(status))).toBe(false);
    }
    expect(isRecoverableErpAccessRefreshError(null)).toBe(false);
  });
});
