import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "logincompanyname";

let ctx: TestContext;

/**
 * Regression contract for a bug found while removing `as any` from the login route.
 *
 * `storage.getUserCompaniesWithRoles()` returns plain `user_company_roles` rows,
 * which carry no company name — there is no join to `companies`. The login route
 * nonetheless read `(userCompanies[0] as any).companyName` twice, so both
 * `session.currentCompanyName` and the `login_history.company_name` column were
 * always null. The cast is what let a property that cannot exist compile.
 *
 * Two sibling paths already resolve the name correctly from `companies` — the
 * company-switch route, and a repair branch in the presence route that exists
 * only to patch the session after the fact. Login now resolves it at the source.
 */
beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60000);

afterAll(async () => {
  closeTestServer();
  try {
    await cleanupTestData(TEST_PREFIX);
  } catch (error) {
    // Login-history persistence is intentionally asynchronous; if its row commits
    // during teardown the company FK can beat the shared cleanup helper.
    if (!String(error).includes("login_history_company_id_fkey")) throw error;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await pool.query("DELETE FROM login_history WHERE company_id = ANY($1::int[])", [[ctx.companyId]]);
    await cleanupTestData(TEST_PREFIX);
  }
}, 30000);

describe("login records the company name", () => {
  it("user_company_roles carries no company name, so login must resolve one", () => {
    const roleColumns = Object.keys(schema.userCompanyRoles);
    expect(roleColumns).toContain("companyId");
    expect(roleColumns).not.toContain("companyName");
  });

  it("writes the real company name to login_history", async () => {
    const agent = request.agent(ctx.app);
    const login = await agent.post("/api/auth/login").send({
      username: `${TEST_PREFIX}_testuser`,
      password: "testpassword123",
    });
    expect(login.status).toBe(200);

    const [company] = await db
      .select({ name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.id, ctx.companyId));
    expect(company?.name).toBeTruthy();

    // login_history is written on a deliberately detached promise.
    let recorded: { companyName: string | null } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      [recorded] = await db
        .select({ companyName: schema.loginHistory.companyName })
        .from(schema.loginHistory)
        .where(eq(schema.loginHistory.userId, ctx.userId))
        .orderBy(desc(schema.loginHistory.id))
        .limit(1);
      if (recorded?.companyName) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(recorded?.companyName).toBe(company.name);
  }, 20000);
});
