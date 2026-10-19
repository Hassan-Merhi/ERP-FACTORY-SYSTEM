import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../server/db", () => ({ db: {} }));

import { registerProtectedCorrectionMutationBoundary } from "../server/middleware/protectedCorrectionMutation";

function createApp(role: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { currentRole: role, userId: "test" } as typeof req.session;
    next();
  });
  registerProtectedCorrectionMutationBoundary(app);
  app.patch("/api/vouchers/:id", (_req, res) => res.json({ ok: true }));
  app.post("/api/vouchers/bulk-delete", (_req, res) => res.json({ ok: true }));
  app.post("/api/voucher-entries", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("posted correction voucher write permissions", () => {
  it("blocks non-developers from changing voucher 16303", async () => {
    const response = await request(createApp("Admin")).patch("/api/vouchers/16303");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CORRECTION_DEVELOPER_ONLY");
  });

  it("allows developers through to ordinary voucher write handlers", async () => {
    const response = await request(createApp("Developer")).patch("/api/vouchers/16303");
    expect(response.status).toBe(200);
  });

  it("rejects bulk deletes involving the correction, but not unrelated vouchers", async () => {
    const app = createApp("Owner");
    expect((await request(app).post("/api/vouchers/bulk-delete").send({ voucherIds: [100, 16303] })).status).toBe(403);
    expect((await request(app).post("/api/vouchers/bulk-delete").send({ voucherIds: [100] })).status).toBe(200);
  });

  it("blocks non-developers from adding entries to the protected voucher", async () => {
    const app = createApp("Admin");
    expect((await request(app).post("/api/voucher-entries").send({ voucherId: 16303 })).status).toBe(403);
    expect((await request(app).post("/api/voucher-entries").send({ voucherId: 12869 })).status).toBe(200);
  });
});
