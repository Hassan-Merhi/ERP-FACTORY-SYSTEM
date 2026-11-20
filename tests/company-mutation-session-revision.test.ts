import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { browserMutationFailClosedBoundary } from "../server/security/browserMutationBoundary";
import {
  LEGACY_COMPANY_REVISION,
  isCompanyScopedMutation,
  verifyExpectedCompanyMutation,
} from "../server/security/companyMutationScope";

const csrf = "session-csrf-token";
const revision = "revision-for-company-2";

function appForSession(companyId: number, companyRevision: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "session", {
      configurable: true,
      value: { userId: "fixture-user", currentCompanyId: companyId, companyRevision, csrfToken: csrf },
    });
    next();
  });
  app.use(browserMutationFailClosedBoundary);
  app.post("/api/vouchers", (req, res) => res.json({ acceptedCompany: req.session.currentCompanyId }));
  app.post("/api/auth/set-company", (_req, res) => res.json({ ok: true }));
  app.post("/api/user-preferences", (_req, res) => res.json({ ok: true }));
  return app;
}

function scopedWrite(app: ReturnType<typeof appForSession>, companyId: string, expectedRevision: string) {
  return request(app)
    .post("/api/vouchers")
    .set("X-Expected-Company-Id", companyId)
    .set("X-Expected-Company-Revision", expectedRevision)
    .send({ amount: 100 });
}

describe("Phase 5 server company mutation scope", () => {
  it("accepts a write only with both current company and exact revision", async () => {
    const response = await scopedWrite(appForSession(2, revision), "2", revision);
    expect(response.status).toBe(200);
    expect(response.body.acceptedCompany).toBe(2);
  });

  it("refuses delayed Company A writes after Company B becomes the session company", async () => {
    const response = await scopedWrite(appForSession(2, revision), "1", "old-company-revision");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("COMPANY_SESSION_CHANGED");
  });

  it("refuses an old revision even after switching away from and back to the same company", async () => {
    const response = await scopedWrite(appForSession(2, revision), "2", "previous-visit-revision");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("COMPANY_SESSION_CHANGED");
  });

  it("refuses partial, invalid, and ambiguous scope headers", async () => {
    const server = appForSession(2, revision);
    for (const id of ["0", "-1", "abc", "2.5", "999999999999999999999"]) {
      const response = await scopedWrite(server, id, revision);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("COMPANY_SCOPE_INVALID");
    }
    const missingRevision = await request(server).post("/api/vouchers").set("X-Expected-Company-Id", "2");
    expect(missingRevision.status).toBe(409);
    expect(missingRevision.body.code).toBe("COMPANY_SCOPE_INVALID");

    const missingId = await request(server).post("/api/vouchers").set("X-Expected-Company-Revision", revision);
    expect(missingId.status).toBe(409);
    expect(missingId.body.code).toBe("COMPANY_SCOPE_INVALID");
  });

  it("supports pre-revision sessions until their first committed switch, then invalidates legacy tokens", async () => {
    expect((await scopedWrite(appForSession(2, undefined), "2", LEGACY_COMPANY_REVISION)).status).toBe(200);
    const afterSwitch = await scopedWrite(appForSession(2, revision), "2", LEGACY_COMPANY_REVISION);
    expect(afterSwitch.status).toBe(409);
  });

  it("keeps untagged legacy clients and explicit global/session endpoints compatible", async () => {
    expect((await request(appForSession(2, revision)).post("/api/vouchers").send({ amount: 1 })).status).toBe(200);
    expect((await request(appForSession(2, revision)).post("/api/auth/set-company").send({ companyId: 1 })).status).toBe(200);
    expect((await request(appForSession(2, revision)).post("/api/user-preferences").send({ view: "table" })).status).toBe(200);
    expect(isCompanyScopedMutation("POST", "/api/auth/set-company")).toBe(false);
    expect(isCompanyScopedMutation("POST", "/api/vouchers")).toBe(true);
  });

  it("does not allow a valid company ID to bypass a mismatched revision", () => {
    const result = verifyExpectedCompanyMutation({
      method: "POST",
      path: "/api/factory/vouchers",
      headers: {
        "x-expected-company-id": "2",
        "x-expected-company-revision": "different",
      },
      session: { currentCompanyId: 2, companyRevision: revision },
    } as Parameters<typeof verifyExpectedCompanyMutation>[0]);
    expect(result).toEqual({ allowed: false, code: "COMPANY_SESSION_CHANGED" });
  });
});
