/**
 * The login flood guard's budget is production policy, and it is also the
 * thing that made the browser smoke suites flaky: they sign in repeatedly from
 * one CI address, the Phase 9 language sweep alone spending nine of the ten
 * attempts because it launches a fresh browser per language x viewport. Once
 * the budget ran out every later sign-in returned 429, and the suites — which
 * did not inspect the sign-in response — waited out their full timeout against
 * an app that was never going to render.
 *
 * These tests pin both halves of the resolution: the production default is
 * still ten per fifteen minutes, and the budget is tunable so a disposable
 * single-tenant runner can raise it without production moving.
 */
import { afterEach, describe, expect, it } from "vitest";

const SOURCE = "server/routes/auth/coreAuthRoutes.ts";

const ENV_KEYS = ["LOGIN_RATE_LIMIT_MAX", "LOGIN_RATE_LIMIT_WINDOW_MS"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Mirrors the reader in coreAuthRoutes so the parsing contract is exercised. */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

describe("login rate limit configuration", () => {
  it("keeps the production budget at ten attempts per fifteen minutes", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(SOURCE, "utf8");

    expect(source).toMatch(/readPositiveInt\(process\.env\.LOGIN_RATE_LIMIT_MAX, 10\)/);
    expect(source).toMatch(/readPositiveInt\(process\.env\.LOGIN_RATE_LIMIT_WINDOW_MS, 15 \* 60 \* 1000\)/);
    // The limiter must consume the resolved values, not re-inline a literal.
    expect(source).toMatch(/windowMs: LOGIN_RATE_LIMIT_WINDOW_MS/);
    expect(source).toMatch(/max: LOGIN_RATE_LIMIT_MAX/);
  });

  it("falls back to the production budget for absent, empty, and unusable values", () => {
    expect(readPositiveInt(undefined, 10)).toBe(10);
    expect(readPositiveInt("", 10)).toBe(10);
    expect(readPositiveInt("not-a-number", 10)).toBe(10);
    expect(readPositiveInt("0", 10)).toBe(10);
    expect(readPositiveInt("-5", 10)).toBe(10);
  });

  it("accepts a raised budget so a CI runner can sign in repeatedly", () => {
    expect(readPositiveInt("100000", 10)).toBe(100000);
    expect(readPositiveInt("900000", 15 * 60 * 1000)).toBe(900000);
  });

  it("documents both variables so verify-env-documentation keeps them visible", async () => {
    const { readFile } = await import("node:fs/promises");
    const example = await readFile(".env.example", "utf8");

    expect(example).toContain("LOGIN_RATE_LIMIT_MAX");
    expect(example).toContain("LOGIN_RATE_LIMIT_WINDOW_MS");
  });

  it("raises the budget for the browser smoke runner in UI Quality", async () => {
    const { readFile } = await import("node:fs/promises");
    const workflow = await readFile(".github/workflows/ui-quality.yml", "utf8");

    // The suites sign in far more often than the production budget allows, and
    // the two API_RATE_LIMIT_* overrides already there do not cover this
    // limiter.
    expect(workflow).toMatch(/LOGIN_RATE_LIMIT_MAX: "100000"/);
  });
});
