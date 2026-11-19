/**
 * Full HTTP app against a factory company that lives only inside one
 * rolled-back transaction.
 *
 * `withFactoryWorld` opens a transaction on one client, routes every pool and
 * drizzle call to it (see routedPoolClient), seeds a factory company with an
 * Admin user holding every named security permission, logs in through the real
 * auth routes and hands the test a supertest agent. Everything - including
 * immutable rows guarded by triggers, vouchers and audit history - disappears
 * on ROLLBACK, so suites need no teardown and cannot collide with each other.
 */
import type { PoolClient } from "pg";
import request from "supertest";
import type express from "express";

import { withRolledBackPool } from "./routedPoolClient";
import { setupTestApp } from "../setup";
import { KNOWN_SECURITY_PERMISSIONS } from "../../server/services/security/namedPermissionService";

let appPromise: Promise<express.Express> | null = null;
let passwordHash: Promise<string> | null = null;
let worldSeq = 0;
let loginSeq = 0;
const PASSWORD = "rolledback-pass-123";

export function rolledBackApp(): Promise<express.Express> {
  appPromise ??= setupTestApp();
  return appPromise;
}

export interface FactoryWorld {
  client: PoolClient;
  agent: ReturnType<typeof request.agent>;
  companyId: number;
  userId: string;
  username: string;
  locationId: number;
  tag: string;
  /** Run one statement and return its first row's `id`. */
  one: (text: string, params?: unknown[]) => Promise<number>;
  /** Run one statement and return its rows. */
  q: <T = Record<string, any>>(text: string, params?: unknown[]) => Promise<T[]>;
  /** Change the logged-in user's role in this company (takes effect next request). */
  setRole: (role: string) => Promise<void>;
  /** Log in a fresh agent for another user of this company with the given role. */
  agentFor: (role: string) => Promise<ReturnType<typeof request.agent>>;
}

async function login(app: express.Express, username: string, companyId: number) {
  const agent = request.agent(app);
  // The login limiter keys on X-Forwarded-For; give each fixture login its own
  // address so a suite of many short worlds never trips it.
  loginSeq += 1;
  const address = `10.${(loginSeq >> 16) & 255}.${(loginSeq >> 8) & 255}.${loginSeq & 255}`;
  const res = await agent
    .post("/api/auth/login")
    .set("X-Forwarded-For", address)
    .send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  const set = await agent.post("/api/auth/set-company").send({ companyId });
  if (set.status !== 200) throw new Error(`set-company failed: ${set.status} ${set.text}`);
  return agent;
}

export async function withFactoryWorld<T>(work: (world: FactoryWorld) => Promise<T>): Promise<T> {
  const app = await rolledBackApp();
  if (!passwordHash) {
    const bcrypt = await import("bcryptjs");
    passwordHash = bcrypt.hash(PASSWORD, 4);
  }
  const hash = await passwordHash;
  return withRolledBackPool(async (client) => {
    // Routed BEGINs become savepoints, where `SET TRANSACTION` is illegal once
    // the outer transaction has run a query. Read-only snapshot routes issue
    // it first thing; let it pass as a no-op so those routes run unchanged.
    const patched = client as unknown as { query: unknown };
    const original = patched.query;
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    patched.query = (text: unknown, ...rest: unknown[]) => {
      const sql = typeof text === "string" ? text : (text as { text?: string } | null)?.text;
      if (typeof sql === "string" && /^\s*SET TRANSACTION\b/i.test(sql)) return query("SELECT 1");
      return query(text, ...rest);
    };
    try {
      return await seedAndRun(client, hash, app, work);
    } finally {
      patched.query = original;
    }
  });
}

async function seedAndRun<T>(
  client: PoolClient,
  hash: string,
  app: express.Express,
  work: (world: FactoryWorld) => Promise<T>
): Promise<T> {
  const tag = `RB${process.pid}${Date.now().toString(36)}${++worldSeq}`.toUpperCase().slice(0, 18);
  const q = async <R = Record<string, any>>(text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as R[];
  const one = async (text: string, params: unknown[] = []) => Number((await q<{ id: number }>(text, params))[0]?.id);
  const companyId = await one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [tag]
  );
  await q(
    `INSERT INTO system_settings (key, value) VALUES ('parentCompanyId', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(companyId)]
  );
  const addUser = async (role: string, suffix: string) => {
    const username = `${tag.toLowerCase()}_${suffix}`;
    const [user] = await q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`, [
      username,
      hash,
    ]);
    await q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [
      user.id,
      companyId,
      role,
    ]);
    for (const permission of KNOWN_SECURITY_PERMISSIONS) {
      await q(
        `INSERT INTO user_security_permissions (user_id, company_id, permission, granted_by) VALUES ($1, $2, $3, $1)`,
        [user.id, companyId, permission]
      );
    }
    return { id: String(user.id), username };
  };
  const admin = await addUser("Admin", "admin");
  const locationId = await one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Yard') RETURNING id`, [
    companyId,
    `${tag}L`,
  ]);
  const agent = await login(app, admin.username, companyId);
  let extra = 0;
  return work({
    client,
    agent,
    companyId,
    userId: admin.id,
    username: admin.username,
    locationId,
    tag,
    one,
    q,
    setRole: async (role) => {
      await q(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
        role,
        admin.id,
        companyId,
      ]);
    },
    agentFor: async (role) => {
      const user = await addUser(role, `u${++extra}`);
      return login(app, user.username, companyId);
    },
  });
}
