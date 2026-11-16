import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: { execute: vi.fn() } }));

import { decideCommercialAccountAdmission, makeCommercialAdmissionBoundary } from "../server/middleware/commercialAccountAdmission";

const account = {
  id: "tenant_first_0001",
  status: "active",
  plan: "business",
  subscription_status: "active",
  member_role: "owner",
};

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    path: "/api/stock-items",
    method: "GET",
    session: { userId: "user_001", currentCompanyId: 101, currentRole: "Owner" },
    query: {},
    body: {},
    params: {},
    ...overrides,
  };
}

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, value: number) {
      this.statusCode = value;
      return this;
    }),
    json: vi.fn(function (this: { body: unknown }, value: unknown) {
      this.body = value;
      return this;
    }),
  };
  return res;
}

describe("commercial ERP admission gate", () => {
  beforeEach(() => {
    process.env.DAKZO_COMMERCIAL_MODE = "enabled";
    process.env.DAKZO_COMMERCIAL_ISOLATED_DATABASE = "confirmed";
  });
  afterEach(() => {
    delete process.env.DAKZO_COMMERCIAL_MODE;
    delete process.env.DAKZO_COMMERCIAL_ISOLATED_DATABASE;
  });

  it("is completely inert for the existing operational ERP when flag is disabled", async () => {
    delete process.env.DAKZO_COMMERCIAL_MODE;
    const lookup = vi.fn();
    const next = vi.fn();
    const middleware = makeCommercialAdmissionBoundary(lookup);
    await middleware(fakeRequest() as never, mockResponse() as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("requires an explicitly certified isolated deployment", async () => {
    delete process.env.DAKZO_COMMERCIAL_ISOLATED_DATABASE;
    const res = mockResponse();
    const next = vi.fn();
    const middleware = makeCommercialAdmissionBoundary(vi.fn());
    await middleware(fakeRequest() as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies anonymous or unbound company sessions", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(vi.fn());
    await boundary(fakeRequest({ session: {} }) as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies developer-level global surfaces even with active membership", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(vi.fn());
    await boundary(fakeRequest({ path: "/api/global/transactions" }) as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires an exact single matching tenant membership", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(vi.fn().mockResolvedValue([account, account]));
    await boundary(fakeRequest() as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects legacy global Developer access even when a session has a company", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(vi.fn().mockResolvedValue([account]));
    await boundary(fakeRequest({ session: { userId: "user_001", currentCompanyId: 101, currentRole: "Developer" } }) as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies unknown or unlicensed ERP routes", async () => {
    const next = vi.fn();
    const repository = vi.fn().mockResolvedValue([account]);
    const boundary = makeCommercialAdmissionBoundary(repository, vi.fn().mockResolvedValue([101]));
    const res = mockResponse();
    await boundary(fakeRequest({ path: "/api/some-new-unsafe-route" }) as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies a request that references a company belonging to another subscriber", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(
      vi.fn().mockResolvedValue([account]),
      vi.fn().mockResolvedValue([101, 102]),
      vi.fn().mockResolvedValue(4),
    );
    await boundary(
      fakeRequest({ body: { destinationCompanyId: 777, operation: { sourceCompanyId: 101 } } }) as never,
      res as never,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies ambiguous or malformed company IDs rather than coercing them", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(
      vi.fn().mockResolvedValue([account]),
      vi.fn().mockResolvedValue([101]),
      vi.fn().mockResolvedValue(4),
    );
    await boundary(fakeRequest({ query: { companyId: ["101", "777"] } }) as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("admits matching active account membership for a scoped company", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(
      vi.fn().mockResolvedValue([account]),
      vi.fn().mockResolvedValue([101, 102]),
    );
    await boundary(fakeRequest({ body: { sourceCompanyId: 101, destinationCompanyId: 102 } }) as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks exceeding user or company limits even if a subscription is active", async () => {
    const next = vi.fn();
    const tooManyUsers = mockResponse();
    await makeCommercialAdmissionBoundary(
      vi.fn().mockResolvedValue([account]),
      vi.fn().mockResolvedValue([101]),
      vi.fn().mockResolvedValue(16),
    )(fakeRequest() as never, tooManyUsers as never, next);
    expect(tooManyUsers.status).toHaveBeenCalledWith(403);
    const tooManyCompanies = mockResponse();
    await makeCommercialAdmissionBoundary(
      vi.fn().mockResolvedValue([account]),
      vi.fn().mockResolvedValue([101,102,103,104]),
      vi.fn().mockResolvedValue(4),
    )(fakeRequest() as never, tooManyCompanies as never, next);
    expect(tooManyCompanies.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies inactive subscriptions even for existing members", () => {
    const decision = decideCommercialAccountAdmission({
      account: { ...account, subscription_status: "past_due" },
      requestedCompanies: [101],
      ownedCompanyIds: [101],
      sessionCompanyId: 101,
    });
    expect(decision.allowed).toBe(false);
  });

  it("fails closed when the membership store is unavailable", async () => {
    const next = vi.fn();
    const res = mockResponse();
    const boundary = makeCommercialAdmissionBoundary(vi.fn().mockRejectedValue(new Error("database offline")));
    await boundary(fakeRequest() as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
});
