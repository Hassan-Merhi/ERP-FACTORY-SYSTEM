import { describe, expect, it, vi } from "vitest";

import { invalidateUserCompanySessions } from "../server/services/security/namedPermissionService";

describe("named permission session invalidation", () => {
  it("treats a missing lazy session table as an empty session store", async () => {
    const missingTable = Object.assign(new Error("relation session does not exist"), { code: "42P01" });
    const pool = { query: vi.fn(async () => Promise.reject(missingTable)) };

    await expect(invalidateUserCompanySessions(pool, "u1", 7)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("still propagates unrelated database failures", async () => {
    const failure = Object.assign(new Error("connection failed"), { code: "08006" });
    const pool = { query: vi.fn(async () => Promise.reject(failure)) };

    await expect(invalidateUserCompanySessions(pool, "u1", 7)).rejects.toBe(failure);
  });
});
