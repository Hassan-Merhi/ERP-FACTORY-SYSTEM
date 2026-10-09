import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("../server/lib/factoryAccessControl", () => ({
  authorizeFactoryPageAccess: mocks.authorize,
  sendFactoryAccessDenied: (res: Response, decision: { code: string; message: string }) =>
    res.status(403).json({ code: decision.code, message: decision.message }),
}));

vi.mock("../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.lookup(),
        }),
      }),
    }),
  },
}));

import { requireFactoryAgentStatementAccount } from "../server/middleware/factoryAgentAccountScope";

function makeRequest(path: string, id = "12", factoryCompanyId = 9): Request {
  return {
    path,
    params: { id },
    session: { userId: "test-user", currentCompanyId: 2, factoryCompanyId },
  } as unknown as Request;
}

function makeResponse() {
  const result: { status?: number; body?: unknown } = {};
  const res = {
    status: vi.fn((status: number) => {
      result.status = status;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      result.body = body;
      return res;
    }),
  } as unknown as Response;
  return { res, result };
}

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({ allowed: true });
  mocks.lookup.mockReset().mockResolvedValue([{ companyId: 9 }]);
});

describe("Factory Agent Ledger statement company scope", () => {
  it("does not change ERP statement authorization", async () => {
    const next = vi.fn() as NextFunction;
    const { res } = makeResponse();
    await requireFactoryAgentStatementAccount(makeRequest("/api/accounts/ledger/12/transactions"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("allows ledger transactions from the factory-pinned company, not the ERP company", async () => {
    const next = vi.fn() as NextFunction;
    const { res } = makeResponse();
    await requireFactoryAgentStatementAccount(makeRequest("/api/factory/agents/ledger/12/transactions"), res, next);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), "factory/agents");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a valid account owned by another company", async () => {
    mocks.lookup.mockResolvedValue([{ companyId: 2 }]);
    const next = vi.fn() as NextFunction;
    const { res, result } = makeResponse();
    await requireFactoryAgentStatementAccount(makeRequest("/api/factory/agents/bank/12/transactions"), res, next);
    expect(result.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies users without access to the Factory Agent Ledger page", async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, code: "FACTORY_PAGE_ACCESS_DENIED", message: "Denied" });
    const next = vi.fn() as NextFunction;
    const { res, result } = makeResponse();
    await requireFactoryAgentStatementAccount(makeRequest("/api/factory/agents/ledger/12/pre-period-balance"), res, next);
    expect(result.status).toBe(403);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects unsupported account types rather than reading arbitrary companies", async () => {
    const next = vi.fn() as NextFunction;
    const { res, result } = makeResponse();
    await requireFactoryAgentStatementAccount(makeRequest("/api/factory/agents/supplier/12/transactions"), res, next);
    expect(result.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("Factory Agent Ledger API wiring", () => {
  const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

  it("uses independent Factory catalog and pinned-agent API paths", () => {
    const hook = source("client/src/pages/agents/useAgentLedger.ts");
    expect(hook).toContain('"/api/factory/agents/accounts"');
    expect(hook).toContain('"/api/factory/agents/pinned"');
    expect(hook).toContain('const statementPrefix = isFactory ? "/api/factory/agents" : "/api/accounts"');
  });

  it("keeps catalog and pinned rows scoped by the Factory company", () => {
    const accounts = source("server/routes/accounts/all.ts");
    const pinned = source("server/routes/admin/import-export/accounts.ts");
    expect(accounts).toContain('app.get("/api/factory/agents/accounts", requireAuth, requireFactoryPageAccess("factory/agents")');
    expect(accounts).toContain("req.session.factoryCompanyId || req.session.currentCompanyId");
    expect(pinned).toContain('"/api/factory/agents/pinned/:accountId"');
    expect(pinned).toContain("const companyId = agentCompanyId(req)");
  });

  it("registers Factory-scoped transaction and opening-balance endpoints", () => {
    const transactions = source("server/routes/accountTransactionRoutes.ts");
    const statements = source("server/routes/accountStatementRoutes.ts");
    for (const type of ["ledger", "bank", "fixed-asset", "employee"]) {
      expect(transactions).toContain(`/api/factory/agents/${type}/:id/transactions`);
    }
    expect(statements).toContain("/api/factory/agents/:type/:id/pre-period-balance");
  });
});
