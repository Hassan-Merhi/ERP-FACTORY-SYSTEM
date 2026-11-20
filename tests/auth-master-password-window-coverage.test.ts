/**
 * Emergency master-password login while its non-production window is open.
 * The window is read from the environment at module load, so this file sets it
 * before the app is imported and restores the environment afterwards.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

const saved = vi.hoisted(() => {
  const keys = ["MASTER_PASSWORD", "MASTER_PASSWORD_ENABLED", "MASTER_PASSWORD_EXPIRES_AT"];
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) previous[key] = process.env[key];
  process.env.MASTER_PASSWORD = "coverage-master-secret";
  process.env.MASTER_PASSWORD_ENABLED = "true";
  process.env.MASTER_PASSWORD_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return previous;
});

import { rolledBackApp, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let ipSeq = 0;
const freshIp = () => `172.30.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;

describe("master-password login window", () => {
  it("signs in with the master password, audits it, and still refuses inactive accounts", async () => {
    await withFactoryWorld(async (w) => {
      const agent = request.agent(await rolledBackApp());
      const res = await agent
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ username: w.username, password: "coverage-master-secret" });
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(w.username);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const audits = await w.q<{ record_identifier: string }>(
        `SELECT record_identifier FROM audit_log WHERE user_id = $1 AND record_identifier LIKE 'MASTER_PASSWORD login%'`,
        [w.userId]
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].record_identifier).toContain(`as '${w.username}'`);

      // Step-up confirmation never accepts the master password.
      const confirm = await agent.post("/api/auth/confirm-password").send({ password: "coverage-master-secret" });
      expect(confirm.status).toBe(403);

      await w.q(`UPDATE users SET active = false WHERE id = $1`, [w.userId]);
      const inactive = await request(await rolledBackApp())
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ username: w.username, password: "coverage-master-secret" });
      expect(inactive.status).toBe(403);
    });
  });

  it("still refuses a wrong password that is not the master password", async () => {
    await withFactoryWorld(async (w) => {
      const res = await request(await rolledBackApp())
        .post("/api/auth/login")
        .set("X-Forwarded-For", freshIp())
        .send({ username: w.username, password: "neither-password" });
      expect(res.status).toBe(401);
    });
  });
});
