import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ pool: { query } }));

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
});

describe("role-scoped global force refresh", () => {
  it("freezes the privileged baseline before issuing a regular-user refresh", async () => {
    const issuedAt = new Date("2026-10-28T13:00:00Z");
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value: "new-regular", updated_at: issuedAt }] });
    const { issueGlobalForceRefresh } = await import("./globalForceRefresh");

    expect(await issueGlobalForceRefresh("regular")).toEqual({
      token: "new-regular",
      issuedAt,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("ON CONFLICT (key) DO NOTHING");
    expect(query.mock.calls[0][1]).toEqual([
      "global_force_refresh_privileged_token",
      "global_force_refresh_token",
    ]);
    expect(query.mock.calls[1][1][0]).toBe("global_force_refresh_token");
    expect(query.mock.calls[1][0]).toContain("INTERVAL '30 seconds'");
  });

  it("only changes the privileged key when refreshing admins/owners/developers", async () => {
    query.mockResolvedValueOnce({
      rows: [{ value: "new-privileged", updated_at: new Date("2026-10-28T13:01:00Z") }],
    });
    const { issueGlobalForceRefresh } = await import("./globalForceRefresh");

    await issueGlobalForceRefresh("privileged");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1][0]).toBe("global_force_refresh_privileged_token");
  });

  it("reads separate tokens per role and safely falls back to the legacy token", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ value: "regular-epoch" }] })
      .mockResolvedValueOnce({ rows: [{ value: "privileged-epoch" }] });
    const { readGlobalForceRefreshToken } = await import("./globalForceRefresh");

    expect(await readGlobalForceRefreshToken("regular")).toBe("regular-epoch");
    expect(await readGlobalForceRefreshToken("privileged")).toBe("privileged-epoch");
    expect(query.mock.calls[0][1]).toEqual(["global_force_refresh_token"]);
    expect(query.mock.calls[1][1]).toEqual([
      "global_force_refresh_privileged_token",
      "global_force_refresh_token",
    ]);
    expect(query.mock.calls[1][0]).toContain("COALESCE");
  });

  it("preserves the 30-second cooldown independently for each target", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const { issueGlobalForceRefresh } = await import("./globalForceRefresh");
    expect(await issueGlobalForceRefresh("privileged")).toBeNull();
  });
});
