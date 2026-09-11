import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["NODE_ENV", "MASTER_PASSWORD", "MASTER_PASSWORD_ENABLED", "MASTER_PASSWORD_EXPIRES_AT"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadPolicy(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return import("./masterPasswordPolicy");
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("masterPasswordPolicy", () => {
  it("removes every master-password control in production", async () => {
    await loadPolicy({
      NODE_ENV: "production",
      MASTER_PASSWORD: "legacy-emergency-secret",
      MASTER_PASSWORD_ENABLED: "true",
      MASTER_PASSWORD_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
    });

    expect(process.env.MASTER_PASSWORD).toBeUndefined();
    expect(process.env.MASTER_PASSWORD_ENABLED).toBeUndefined();
    expect(process.env.MASTER_PASSWORD_EXPIRES_AT).toBeUndefined();
  });

  it("keeps an explicitly enabled, unexpired development emergency password", async () => {
    await loadPolicy({
      NODE_ENV: "development",
      MASTER_PASSWORD: "dev-emergency-secret",
      MASTER_PASSWORD_ENABLED: "true",
      MASTER_PASSWORD_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
    });

    expect(process.env.MASTER_PASSWORD).toBe("dev-emergency-secret");
  });

  it("removes an incomplete development emergency password configuration", async () => {
    await loadPolicy({
      NODE_ENV: "development",
      MASTER_PASSWORD: "dev-emergency-secret",
      MASTER_PASSWORD_ENABLED: "false",
      MASTER_PASSWORD_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
    });

    expect(process.env.MASTER_PASSWORD).toBeUndefined();
  });

  it("expires an enabled emergency password at runtime without a restart", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
      const policy = await loadPolicy({
        NODE_ENV: "development",
        MASTER_PASSWORD: "dev-emergency-secret",
        MASTER_PASSWORD_ENABLED: "true",
        MASTER_PASSWORD_EXPIRES_AT: "2026-06-01T12:05:00.000Z",
      });

      expect(process.env.MASTER_PASSWORD).toBe("dev-emergency-secret");
      expect(policy.isMasterPasswordWindowActive()).toBe(true);

      // The process outlives the window: the emergency password must stop
      // working on the next attempt even though nothing was restarted.
      vi.setSystemTime(new Date("2026-06-01T12:06:00.000Z"));
      expect(policy.isMasterPasswordWindowActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports the emergency password window as active in production", async () => {
    const policy = await loadPolicy({
      NODE_ENV: "production",
      MASTER_PASSWORD: "legacy-emergency-secret",
      MASTER_PASSWORD_ENABLED: "true",
      MASTER_PASSWORD_EXPIRES_AT: "2999-01-01T00:00:00.000Z",
    });

    expect(policy.isMasterPasswordWindowActive()).toBe(false);
  });
});
