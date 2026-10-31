import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "Admin",
  posViewOnly: false,
  allowMembership: true,
  summaryCalls: [] as unknown[][],
}));
const SITE = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";

vi.mock("../server/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../server/auth", () => ({
  requireAuth: (
    req: { session?: { userId?: string } },
    res: { status: (n: number) => { end: () => void } },
    next: () => void
  ) => (req.session?.userId ? next() : res.status(401).end()),
}));
vi.mock("../server/security/companyAccessBoundary", () => {
  class CompanyAccessError extends Error {}
  return {
    CompanyAccessError,
    assertActiveCompanyAccess: async () => {
      if (!state.allowMembership) throw new CompanyAccessError("revoked");
    },
    sendCompanyAccessError: (res: { status: (n: number) => { json: (input: unknown) => void } }) =>
      res.status(403).json({ code: "COMPANY_ACCESS_DENIED" }),
  };
});
vi.mock("../server/services/security/activeCompanyPermissionContext", () => ({
  ActiveCompanyPermissionContextError: class extends Error {},
  getActiveCompanyPermissionContext: async () => ({ role: state.role, posViewOnly: state.posViewOnly }),
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", () => ({
  readFactoryEdgeConfiguration: () => ({ mode: "lan", siteId: SITE, primary: false, writeMode: "read-only" }),
  edgeStatusPayload: () => ({ mode: "lan", siteId: SITE, writeMode: "read-only" }),
  edgeBlocksWrite: () => true,
}));
vi.mock("../server/edge/edgeSyncReceiver", () => ({ registerCloudEdgeSyncReceiver: () => undefined }));
vi.mock("../server/edge/edgeDatabaseProof.mjs", () => ({ hasFactoryEdgeData: async () => true }));
vi.mock("../server/edge/phase7WriterGate.mjs", () => ({ hasVerifiedPhase7WriterAuthority: async () => false }));
vi.mock("../server/edge/phase10Handover.mjs", () => ({
  summarizeLanEvidence: async (...args: unknown[]) => {
    state.summaryCalls.push(args);
    return { siteId: SITE, pendingTotal: 3, handoverReady: false, relayPaused: false, streams: [] };
  },
}));

import { registerFactoryEdgeBoundary } from "../server/edge/edgeBoundary";

function app(userId?: string) {
  const server = express();
  server.use((req, _res, next) => {
    if (userId) Object.assign(req, { session: { userId, currentCompanyId: 5 } });
    next();
  });
  registerFactoryEdgeBoundary(server);
  return server;
}

beforeEach(() => {
  state.role = "Admin";
  state.posViewOnly = false;
  state.allowMembership = true;
  state.summaryCalls = [];
});

describe("Phase 10 LAN operator status", () => {
  it("returns the site-scoped evidence report to an Admin/Owner, uncached", async () => {
    const res = await request(app("lead-1")).get("/api/edge/operator/status");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ siteId: SITE, pendingTotal: 3, handoverReady: false });
    expect(state.summaryCalls[0][1]).toBe(SITE);
  });

  it("refuses anonymous, revoked, non-admin and view-only callers without reading evidence", async () => {
    expect((await request(app()).get("/api/edge/operator/status")).status).toBe(401);
    state.allowMembership = false;
    expect((await request(app("lead-1")).get("/api/edge/operator/status")).status).toBe(403);
    state.allowMembership = true;
    state.role = "Factory Worker";
    expect((await request(app("worker-1")).get("/api/edge/operator/status")).body.code).toBe(
      "EDGE_OPERATOR_ROLE_REQUIRED"
    );
    state.role = "Owner";
    state.posViewOnly = true;
    expect((await request(app("owner-1")).get("/api/edge/operator/status")).status).toBe(403);
    expect(state.summaryCalls).toHaveLength(0);
  });
});
