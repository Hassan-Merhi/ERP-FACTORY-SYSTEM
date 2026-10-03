/**
 * server/httpApp.ts: routes match exactly as declared, so a differently-cased
 * URL cannot reach a handler past guards that compare paths case-sensitively.
 */
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../server/httpApp";

function buildApp() {
  const app = createHttpApp();
  app.get("/api/accounts/all", (_req, res) => res.json({ ok: true }));
  app.get("/api/barcode/:code", (req, res) => res.json({ code: req.params.code }));
  app.use("/api/factory", (_req, res) => res.json({ mounted: true }));
  return app;
}

describe("case-sensitive routing", () => {
  it("serves the declared spelling and 404s any other casing", async () => {
    const app = buildApp();
    await request(app).get("/api/accounts/all").expect(200);
    await request(app).get("/api/ACCOUNTS/all").expect(404);
    await request(app).get("/api/Accounts/All").expect(404);
  });

  it("keeps route parameters as sent", async () => {
    const response = await request(buildApp()).get("/api/barcode/REF-001").expect(200);
    expect(response.body).toEqual({ code: "REF-001" });
  });

  it("matches middleware mount paths the same way", async () => {
    const app = buildApp();
    await request(app).get("/api/factory/workers").expect(200);
    await request(app).get("/api/FACTORY/workers").expect(404);
  });
});
