import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../server/db", () => ({ pool: mockDb }));

import {
  V2PolicyError,
  assertV2ChangesSafe,
  saveV2Rules,
  readV2Revision,
} from "../server/services/security/accessControlV2Store";

const actor = { companyId: 11, userId: "admin-1" };
const change = { resource: "erp.vouchers", action: "create", decision: "allow" } as const;

describe("Permissions V2 Phase 2 shadow store", () => {
  let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    client = { query: vi.fn(), release: vi.fn() };
    mockDb.connect.mockResolvedValue(client);
    client.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT revision::text")) return { rows: [{ revision: "0", mode: "shadow" }] };
      if (sql.includes("RETURNING id::text")) return { rows: [{ id: "100" }] };
      if (sql.includes("SELECT r.resource_key") || sql.includes("SELECT resource_key, action_key")) return { rows: [] };
      if (sql.includes("SELECT role FROM user_company_roles")) return { rows: [{ role: "Manager" }] };
      return { rows: [], rowCount: 1 };
    });
  });

  it("records rule changes, policy revision and append-only audit in one transaction", async () => {
    await expect(saveV2Rules({
      actor,
      subject: { kind: "role", roleKey: "Create Only" },
      expectedRevision: 0,
      reason: "New role permissions draft",
      changes: [change],
    })).resolves.toEqual({ revision: 1, mode: "shadow", applied: 1 });

    const calls = client.query.mock.calls;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls.some(([sql]) => String(sql).includes("FOR UPDATE"))).toBe(true);
    expect(calls.some(([sql]) => String(sql).includes("INSERT INTO access_role_rules"))).toBe(true);
    const audit = calls.find(([sql]) => String(sql).includes("INSERT INTO access_policy_change_audit"));
    expect(audit).toBeDefined();
    expect(audit?.[1][0]).toBe(actor.companyId);
    expect(audit?.[1][2]).toBe(actor.userId);
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
    expect(calls.some(([sql]) => String(sql).includes("role_feature_permissions"))).toBe(false);
  });

  it("rejects a stale writer before any rules or audit are changed", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision::text")) return { rows: [{ revision: "7", mode: "shadow" }] };
      return { rows: [], rowCount: 1 };
    });
    await expect(saveV2Rules({
      actor, subject: { kind: "role", roleKey: "Manager" },
      expectedRevision: 6, reason: "Prevent conflicting updates", changes: [change],
    })).rejects.toMatchObject({ code: "POLICY_STALE_REVISION", status: 409 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO access_role_rules"))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not let a user override target a person from another company", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT revision::text")) return { rows: [{ revision: "0", mode: "shadow" }] };
      if (sql.includes("SELECT role FROM user_company_roles")) return { rows: [] };
      return { rows: [] };
    });
    await expect(saveV2Rules({
      actor, subject: { kind: "user", userId: "outside-company" },
      expectedRevision: 0, reason: "Cross-company attempt blocked", changes: [change],
    })).rejects.toMatchObject({ code: "USER_NOT_IN_COMPANY", status: 404 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("access_user_overrides"))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("preserves all business data and refuses protected privileges", () => {
    expect(() => assertV2ChangesSafe("Create Only", [
      { resource: "erp.vouchers", action: "delete", decision: "allow" },
    ])).toThrow(V2PolicyError);
    expect(() => assertV2ChangesSafe("Manager", [
      { resource: "system.users", action: "manage_users", decision: "allow" },
    ])).toThrow(V2PolicyError);
    expect(() => assertV2ChangesSafe("Admin", [change])).toThrow(V2PolicyError);
    expect(() => assertV2ChangesSafe(null, [change, change])).toThrow(V2PolicyError);
    expect(() => assertV2ChangesSafe("Create Only", [change])).not.toThrow();
  });

  it("reads revision zero when no V2 state was created for a company", async () => {
    mockDb.query.mockResolvedValue({ rows: [] });
    await expect(readV2Revision(11)).resolves.toEqual({ revision: 0, mode: "shadow" });
  });
});
