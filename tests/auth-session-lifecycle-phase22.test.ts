import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase22auth";
const PASSWORD = "testpassword123";

let ctx: TestContext;

function sessionCookie(response: request.Response): string | null {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const sid = cookies.find((cookie) => cookie.startsWith("connect.sid="));
  return sid?.split(";", 1)[0] ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

describe("Phase 22 — authentication/session HTTP lifecycle", () => {
  it("regenerates a new session identity for a fresh login cycle", async () => {
    const agent = request.agent(ctx.app);

    const firstLogin = await agent.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: PASSWORD,
    });
    expect(firstLogin.status).toBe(200);
    const firstSid = sessionCookie(firstLogin);
    expect(firstSid).toMatch(/^connect\.sid=/);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(`${TEST_PREFIX}_testuser`);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(200);

    const afterLogout = await agent.get("/api/auth/me");
    expect(afterLogout.status).toBe(401);

    const secondLogin = await agent.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: PASSWORD,
    });
    expect(secondLogin.status).toBe(200);
    const secondSid = sessionCookie(secondLogin);
    expect(secondSid).toMatch(/^connect\.sid=/);
    expect(secondSid).not.toBe(firstSid);
  });

  it("does not create an authenticated session for rejected credentials", async () => {
    const rejected = request.agent(ctx.app);
    const login = await rejected.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: "definitely-not-the-password",
    });
    expect(login.status).toBe(401);

    const me = await rejected.get("/api/auth/me");
    expect(me.status).toBe(401);
  });
});
