/**
 * Core auth routes (login, logout, me, password change, step-up confirmation)
 * against the real app inside one rolled-back transaction per test. Every
 * refusal is checked to leave the stored credential and session state alone.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

import { rolledBackApp, withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let ipSeq = 0;
const freshIp = () => `172.31.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;
const PASSWORD = "rolledback-pass-123";

async function login(username: unknown, password: unknown, ip = freshIp()) {
  return request(await rolledBackApp())
    .post("/api/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ username, password });
}

async function storedHash(w: FactoryWorld, userId = w.userId) {
  const [row] = await w.q<{ password: string }>(`SELECT password FROM users WHERE id = $1`, [userId]);
  return row.password;
}

async function loginHistoryCount(w: FactoryWorld, username: string) {
  const [row] = await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM login_history WHERE username = $1`, [
    username,
  ]);
  return row.n;
}

describe("POST /api/auth/login", () => {
  it("refuses missing fields, unknown users and wrong passwords without creating a session", async () => {
    await withFactoryWorld(async (w) => {
      const before = await loginHistoryCount(w, w.username);
      expect((await login(w.username, "")).status).toBe(400);
      expect((await login("", PASSWORD)).status).toBe(400);
      const unknown = await login(`${w.username}_nobody`, PASSWORD);
      expect(unknown.status).toBe(401);
      expect(unknown.body).toEqual({ message: "Invalid credentials" });
      const wrong = await login(w.username, "not-the-password");
      expect(wrong.status).toBe(401);
      expect(wrong.headers["set-cookie"] ?? []).toEqual([]);
      expect(await loginHistoryCount(w, w.username)).toBe(before);
    });
  });

  it("refuses an inactive account even with the right password", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE users SET active = false WHERE id = $1`, [w.userId]);
      const before = await loginHistoryCount(w, w.username);
      const res = await login(w.username, PASSWORD);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ message: "Account is inactive" });
      expect(await loginHistoryCount(w, w.username)).toBe(before);
    });
  });

  it("signs in a user with no company role and records the login without a company", async () => {
    await withFactoryWorld(async (w) => {
      const username = `${w.tag.toLowerCase()}_nocompany`;
      await w.q(`INSERT INTO users (username, password) VALUES ($1, $2)`, [username, await bcrypt.hash(PASSWORD, 4)]);
      const agent = request.agent(await rolledBackApp());
      const res = await agent
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ username, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(username);
      expect(res.body.password).toBeUndefined();
      // Login history is written fire-and-forget; give it a moment on the shared client.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [row] = await w.q<{ company_id: number | null; company_name: string | null }>(
        `SELECT company_id, company_name FROM login_history WHERE username = $1`,
        [username]
      );
      expect(row).toEqual({ company_id: null, company_name: null });
      // Without any company role the session is not an authenticated app user.
      expect((await agent.get("/api/auth/me")).status).toBe(401);
    });
  });

  it("records the first company name on login", async () => {
    await withFactoryWorld(async (w) => {
      const agent = request.agent(await rolledBackApp());
      const res = await agent
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .set("User-Agent", "coverage-agent")
        .send({ username: w.username, password: PASSWORD });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await w.q<{ company_id: number; company_name: string; user_agent: string }>(
        `SELECT company_id, company_name, user_agent FROM login_history WHERE username = $1 AND user_agent = 'coverage-agent'`,
        [w.username]
      );
      expect(rows).toEqual([{ company_id: w.companyId, company_name: w.tag, user_agent: "coverage-agent" }]);
      const me = await agent.get("/api/auth/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ username: w.username, currentCompanyId: w.companyId, currentRole: "Admin" });
    });
  });

  it("falls back to the socket address when no forwarded address is sent", async () => {
    await withFactoryWorld(async (w) => {
      const res = await request(await rolledBackApp())
        .post("/api/auth/login")
        .send({ username: w.username, password: PASSWORD });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await w.q<{ ip_address: string }>(
        `SELECT ip_address FROM login_history WHERE username = $1 ORDER BY id DESC LIMIT 1`,
        [w.username]
      );
      expect(rows[0].ip_address).toMatch(/127\.0\.0\.1|::1/);
    });
  });

  it("rate limits repeated attempts from one address", async () => {
    await withFactoryWorld(async (w) => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        statuses.push((await login(`${w.username}_nobody`, "x", ip)).status);
      }
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      const limited = await login(w.username, PASSWORD, ip);
      expect(limited.status).toBe(429);
      expect(limited.body.message).toContain("Too many login attempts");
    });
  });
});

describe("logout and me", () => {
  it("logs out, clears the cookie and refuses /me afterwards", async () => {
    await withFactoryWorld(async (w) => {
      const out = await w.agent.post("/api/auth/logout");
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ message: "Logged out successfully" });
      expect(out.headers["cache-control"]).toBe("no-store");
      expect((await w.agent.get("/api/auth/me")).status).toBe(401);
    });
  });

  it("refuses /me for an anonymous client", async () => {
    await withFactoryWorld(async () => {
      expect((await request(await rolledBackApp()).get("/api/auth/me")).status).toBe(401);
    });
  });
});

describe("PATCH /api/me/password", () => {
  it("refuses every invalid request and leaves the stored hash unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const hash = await storedHash(w);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ currentPassword: PASSWORD, newPassword: "abcdefg" }, "All password fields are required."],
        [{ currentPassword: PASSWORD, newPassword: "  ab  ", confirmPassword: "  ab  " }, "at least 6 characters"],
        [{ currentPassword: PASSWORD, newPassword: "abcdefg", confirmPassword: "abcdefh" }, "do not match"],
        [
          { currentPassword: "wrong-pass", newPassword: "abcdefg", confirmPassword: "abcdefg" },
          "Current password is incorrect.",
        ],
      ];
      for (const [body, message] of cases) {
        const res = await w.agent.patch("/api/me/password").send(body);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain(message);
      }
      expect(await storedHash(w)).toBe(hash);
    });
  });

  it("changes the password, keeps this session and accepts the new password", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent
        .patch("/api/me/password")
        .send({ currentPassword: PASSWORD, newPassword: "brand-new-pass", confirmPassword: "brand-new-pass" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(await bcrypt.compare("brand-new-pass", await storedHash(w))).toBe(true);
      expect((await w.agent.get("/api/auth/me")).status).toBe(200);
      expect((await login(w.username, PASSWORD)).status).toBe(401);
      expect((await login(w.username, "brand-new-pass")).status).toBe(200);
    });
  });

  it("requires a login", async () => {
    await withFactoryWorld(async () => {
      const res = await request(await rolledBackApp())
        .patch("/api/me/password")
        .send({ currentPassword: "a", newPassword: "abcdefg", confirmPassword: "abcdefg" });
      expect(res.status).toBe(401);
    });
  });
});

describe("POST /api/auth/confirm-password", () => {
  it("refuses a missing, non-string or wrong password and accepts the right one", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/auth/confirm-password").send({})).status).toBe(400);
      expect((await w.agent.post("/api/auth/confirm-password").send({ password: 12345 })).status).toBe(400);
      const wrong = await w.agent.post("/api/auth/confirm-password").send({ password: "nope" });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toEqual({ message: "Incorrect password" });
      const ok = await w.agent.post("/api/auth/confirm-password").send({ password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true });
    });
  });

  it("answers 401 when the session user no longer exists", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.agentFor("Admin");
      const [row] = await w.q<{ id: string }>(`SELECT id FROM users WHERE username = $1`, [
        `${w.tag.toLowerCase()}_u1`,
      ]);
      await w.q(`DELETE FROM user_security_permissions WHERE user_id = $1`, [row.id]);
      await w.q(`DELETE FROM user_company_roles WHERE user_id = $1`, [row.id]);
      await w.q(`DELETE FROM users WHERE id = $1`, [row.id]);
      const res = await other.post("/api/auth/confirm-password").send({ password: PASSWORD });
      expect(res.status).toBe(401);
    });
  });
});
