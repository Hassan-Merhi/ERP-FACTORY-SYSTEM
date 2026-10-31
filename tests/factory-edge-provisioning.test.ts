import { describe, expect, it, vi } from "vitest";
import { hasFactoryEdgeData } from "../server/edge/edgeDatabaseProof.mjs";

describe("LAN data provisioning safety gate", () => {
  it("refuses empty tables and missing schema", async () => {
    expect(
      await hasFactoryEdgeData({
        query: vi.fn().mockResolvedValue({ rows: [{ users_table: false, companies_table: true }] }),
      })
    ).toBe(false);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ users_table: true, companies_table: true }] })
      .mockResolvedValueOnce({ rows: [{ users: true, companies: false }] });
    expect(await hasFactoryEdgeData({ query })).toBe(false);
  });
  it("requires both companies and users and fails closed when PostgreSQL is unavailable", async () => {
    const good = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ users_table: true, companies_table: true }] })
      .mockResolvedValueOnce({ rows: [{ users: true, companies: true }] });
    expect(await hasFactoryEdgeData({ query: good })).toBe(true);
    expect(await hasFactoryEdgeData({ query: vi.fn().mockRejectedValue(new Error("connection lost")) })).toBe(false);
  });
});
