import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authChecks: 0,
  membershipChecks: 0,
  allowMembership: true,
  rows: [] as Array<Record<string, unknown>>,
  queryArgs: [] as unknown[][],
}));
const SITE = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const OP = "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c";

vi.mock("../server/db", () => ({
  pool: {
    query: async (_sql: string, args: unknown[]) => {
      state.queryArgs.push(args);
      return { rows: state.rows };
    },
  },
}));
vi.mock("../server/auth", () => ({
  requireAuth: (
    req: { session?: { userId?: string } },
    res: { status: (n: number) => { end: () => void } },
    next: () => void
  ) => {
    state.authChecks++;
    if (!req.session?.userId) return res.status(401).end();
    return next();
  },
}));
vi.mock("../server/security/companyAccessBoundary", () => {
  class CompanyAccessError extends Error {
    status = 403;
    code = "COMPANY_ACCESS_DENIED";
  }
  return {
    CompanyAccessError,
    assertActiveCompanyAccess: async () => {
      state.membershipChecks++;
      if (!state.allowMembership) throw new CompanyAccessError("Company permission revoked");
    },
    sendCompanyAccessError: (res: { status: (n: number) => { json: (input: unknown) => void } }) =>
      res.status(403).json({ code: "COMPANY_ACCESS_DENIED" }),
  };
});
vi.mock("../server/edge/edgeRuntimePolicy.mjs", () => ({
  readFactoryEdgeConfiguration: () => ({
    mode: "lan",
    siteId: SITE,
    primary: false,
    writeMode: "read-only",
  }),
  edgeStatusPayload: () => ({ mode: "lan", siteId: SITE, writeMode: "read-only" }),
  edgeBlocksWrite: () => true,
}));
vi.mock("../server/edge/edgeSyncReceiver", () => ({
  registerCloudEdgeSyncReceiver: () => undefined,
}));
vi.mock("../server/edge/edgeDatabaseProof.mjs", () => ({
  hasFactoryEdgeData: async () => true,
}));
vi.mock("../server/edge/phase7WriterGate.mjs", () => ({
  hasVerifiedPhase7WriterAuthority: async () => false,
}));

import { registerFactoryEdgeBoundary } from "../server/edge/edgeBoundary";

function fixture(actor?: { userId: string; companyId: number }) {
  const app = express();
  app.use((req, _res, next) => {
    if (actor) {
      Object.assign(req, { session: { userId: actor.userId, currentCompanyId: actor.companyId } });
    }
    next();
  });
  registerFactoryEdgeBoundary(app);
  return app;
}

beforeEach(() => {
  state.authChecks = 0;
  state.membershipChecks = 0;
  state.allowMembership = true;
  state.rows = [];
  state.queryArgs = [];
});

describe("Phase 9 LAN status HTTP authorization", () => {
  it("keeps the ordinary edge status identity probe available without login", async () => {
    const res = await request(fixture()).get("/api/edge/status");
    expect(res.status).toBe(200);
    expect(res.body.writeMode).toBe("read-only");
    expect(state.authChecks).toBe(0);
    expect(state.membershipChecks).toBe(0);
  });
  it("requires a live credential-aware session for operation evidence", async () => {
    const res = await request(fixture()).get("/api/edge/status?operationId=" + OP);
    expect(res.status).toBe(401);
    expect(state.authChecks).toBe(1);
    expect(state.queryArgs).toHaveLength(0);
  });
  it("rejects revoked company membership before reading even matching outbox data", async () => {
    state.allowMembership = false;
    const res = await request(fixture({ userId: "user-7", companyId: 42 })).get("/api/edge/status?operationId=" + OP);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("COMPANY_ACCESS_DENIED");
    expect(state.authChecks).toBe(1);
    expect(state.membershipChecks).toBe(1);
    expect(state.queryArgs).toHaveLength(0);
  });
  it("uses all four scope selectors and returns 404 rather than revealing another user's record", async () => {
    const res = await request(fixture({ userId: "user-7", companyId: 42 })).get("/api/edge/status?operationId=" + OP);
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(state.queryArgs[0]).toEqual([SITE, OP, 42, "user-7"]);
  });
  it("rejects invalid and ambiguous operation IDs before executing receipt SQL", async () => {
    const app = fixture({ userId: "user-7", companyId: 42 });
    expect((await request(app).get("/api/edge/status?operationId=bad")).status).toBe(400);
    expect((await request(app).get("/api/edge/status?operationId=" + OP + "&operationId=" + OP)).status).toBe(400);
    expect(state.queryArgs).toHaveLength(0);
  });
});
