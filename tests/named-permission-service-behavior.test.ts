import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  permissions: { userId: "permission.userId", companyId: "permission.companyId", permission: "permission.permission" },
  roles: { userId: "role.userId", companyId: "role.companyId" },
}));

vi.mock("@shared/schema", () => ({
  userSecurityPermissions: harness.permissions,
  userCompanyRoles: harness.roles,
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
}));

import {
  SecuritySchemaUnavailableError,
  assertUserBelongsToCompany,
  hydrateSessionNamedPermissions,
  invalidateUserCompanySessions,
  loadNamedPermissions,
  normalizePermissionList,
  replaceNamedPermissions,
} from "../server/services/security/namedPermissionService";

function selectDb(rows: any[] | Promise<any[]>) {
  const builder: any = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(async () => (await rows).slice(0, 1)),
    then: (resolve: (value: any[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return { select: vi.fn(() => builder) };
}

describe("named permission service behavior", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes, deduplicates, sorts, and validates known permissions", () => {
    expect(normalizePermissionList(["files.download", " administration.repair ", "files.download", ""])).toEqual([
      "administration.repair",
      "files.download",
    ]);
    expect(() => normalizePermissionList("files.download")).toThrow("Invalid permissions");
    expect(() => normalizePermissionList(["files.download", "unknown.permission"])).toThrow("Invalid permissions");
  });

  it("loads unique sorted permissions and fails closed when the security schema is unavailable", async () => {
    const db = selectDb([
      { permission: "files.download" },
      { permission: "administration.repair" },
      { permission: "files.download" },
    ]);
    await expect(loadNamedPermissions(db, "u1", 4)).resolves.toEqual(["administration.repair", "files.download"]);

    const schemaError: any = new Error("missing table");
    schemaError.code = "42P01";
    const failing = selectDb(Promise.reject(schemaError));
    await expect(loadNamedPermissions(failing, "u1", 4)).rejects.toBeInstanceOf(SecuritySchemaUnavailableError);

    const ordinary = selectDb(Promise.reject(new Error("network")));
    await expect(loadNamedPermissions(ordinary, "u1", 4)).rejects.toThrow("network");
  });

  it("requires company membership", async () => {
    await expect(assertUserBelongsToCompany(selectDb([{ userId: "u1" }]), "u1", 2)).resolves.toBeUndefined();
    await expect(assertUserBelongsToCompany(selectDb([]), "u1", 2)).rejects.toThrow("User not found");
  });

  it("replaces permissions transactionally and supports clearing all permissions", async () => {
    const membershipBuilder: any = {
      from: vi.fn(() => membershipBuilder),
      where: vi.fn(() => membershipBuilder),
      limit: vi.fn(async () => [{ userId: "u1" }]),
    };
    const deleteBuilder: any = { where: vi.fn(async () => undefined) };
    const insertBuilder: any = { values: vi.fn(async () => undefined) };
    const tx: any = {
      select: vi.fn(() => membershipBuilder),
      delete: vi.fn(() => deleteBuilder),
      insert: vi.fn(() => insertBuilder),
    };

    await expect(
      replaceNamedPermissions(tx, {
        userId: "u1",
        companyId: 5,
        permissions: ["files.download", "administration.repair"],
        grantedBy: "admin",
      })
    ).resolves.toEqual(["administration.repair", "files.download"]);
    expect(insertBuilder.values).toHaveBeenCalledWith([
      expect.objectContaining({ userId: "u1", companyId: 5, permission: "administration.repair", grantedBy: "admin" }),
      expect.objectContaining({ userId: "u1", companyId: 5, permission: "files.download", grantedBy: "admin" }),
    ]);

    insertBuilder.values.mockClear();
    await expect(
      replaceNamedPermissions(tx, { userId: "u1", companyId: 5, permissions: [], grantedBy: "admin" })
    ).resolves.toEqual([]);
    expect(insertBuilder.values).not.toHaveBeenCalled();
  });

  it("hydrates invalid, cached, legacy cached, and company-switched sessions correctly", async () => {
    const invalid: any = {};
    await expect(hydrateSessionNamedPermissions(selectDb([]), invalid)).resolves.toEqual([]);
    expect(invalid).toMatchObject({ securityPermissions: [], securityPermissionsCompanyId: null });

    const cached: any = {
      userId: "u1",
      currentCompanyId: 3,
      securityPermissions: ["files.download"],
      securityPermissionsCompanyId: 3,
    };
    await expect(hydrateSessionNamedPermissions(selectDb([]), cached)).resolves.toEqual(["files.download"]);

    const legacyCached: any = { userId: "u1", currentCompanyId: 3, securityPermissions: ["files.download"] };
    await expect(hydrateSessionNamedPermissions(selectDb([]), legacyCached)).resolves.toEqual(["files.download"]);
    expect(legacyCached.securityPermissionsCompanyId).toBe(3);

    const switched: any = {
      userId: "u1",
      currentCompanyId: 4,
      securityPermissions: ["files.download"],
      securityPermissionsCompanyId: 3,
    };
    await expect(
      hydrateSessionNamedPermissions(selectDb([{ permission: "security.anomalies.read" }]), switched)
    ).resolves.toEqual(["security.anomalies.read"]);
    expect(switched.securityPermissionsCompanyId).toBe(4);
  });

  // The narrowing added when postgresErrorCode/isSecuritySchemaError moved from
  // `any` to `unknown` introduced branches the suite did not reach: a rejection
  // that is not an object at all, and one that carries its driver code on
  // `cause` rather than directly. Both decide whether a failure is reported as
  // SecuritySchemaUnavailableError (a 503) or propagated as-is, so they matter.
  it("classifies schema failures by driver code whether it is direct, nested on cause, or absent", async () => {
    const nestedCause = Object.assign(new Error("wrapped"), { cause: { code: "42703" } });
    await expect(loadNamedPermissions(selectDb(Promise.reject(nestedCause)), "u1", 4)).rejects.toBeInstanceOf(
      SecuritySchemaUnavailableError
    );

    // A non-object rejection has no code to read: it must propagate untouched
    // rather than be misreported as a missing-schema condition.
    await expect(loadNamedPermissions(selectDb(Promise.reject("boom")), "u1", 4)).rejects.toBe("boom");

    const unrelatedCause = Object.assign(new Error("wrapped"), { cause: { code: "23505" } });
    await expect(loadNamedPermissions(selectDb(Promise.reject(unrelatedCause)), "u1", 4)).rejects.toBe(unrelatedCause);
  });

  // Likewise, `typeof companyId !== "number"` is a new guard: the pre-existing
  // invalid-session case has no userId, so it short-circuits before the company
  // check is ever evaluated.
  it("refuses to hydrate when the company id is absent or not a usable positive integer", async () => {
    for (const currentCompanyId of [undefined, 0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const session: any = {
        userId: "u1",
        currentCompanyId,
        securityPermissions: ["files.download"],
        securityPermissionsCompanyId: 9,
      };
      await expect(hydrateSessionNamedPermissions(selectDb([]), session)).resolves.toEqual([]);
      expect(session).toMatchObject({ securityPermissions: [], securityPermissionsCompanyId: null });
    }
  });

  it("loads from the database when the session carries no cached permission array", async () => {
    const fresh: any = { userId: "u1", currentCompanyId: 7 };
    await expect(
      hydrateSessionNamedPermissions(selectDb([{ permission: "inventory.cost.view" }]), fresh)
    ).resolves.toEqual(["inventory.cost.view"]);
    expect(fresh).toMatchObject({
      securityPermissions: ["inventory.cost.view"],
      securityPermissionsCompanyId: 7,
    });

    // A non-array cache is treated the same as none: it must not be trusted.
    const poisoned: any = { userId: "u1", currentCompanyId: 7, securityPermissions: "files.download" };
    await expect(
      hydrateSessionNamedPermissions(selectDb([{ permission: "files.download" }]), poisoned)
    ).resolves.toEqual(["files.download"]);
  });

  it("drops non-string permission entries rather than rejecting the list", () => {
    // Documenting actual behaviour, which is not what the name of the function
    // suggests: a non-string entry is mapped to "" and filtered out, so the
    // list is accepted with that entry silently discarded. It fails closed -
    // the caller ends up with fewer permissions, never more - so it is recorded
    // here rather than changed inside a typing wave.
    expect(normalizePermissionList(["files.download", 42])).toEqual(["files.download"]);
    expect(normalizePermissionList([null])).toEqual([]);

    // A value that is a string but not a known permission is still rejected.
    expect(() => normalizePermissionList(["files.download", "not.a.permission"])).toThrow("Invalid permissions");
    expect(() => normalizePermissionList("nope")).toThrow("Invalid permissions");
    expect(normalizePermissionList(["  files.download  "])).toEqual(["files.download"]);
  });

  it("invalidates only sessions belonging to the affected user and company", async () => {
    const pool = { query: vi.fn(async () => undefined) };
    await invalidateUserCompanySessions(pool, "u9", 12);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM session"), ["u9", 12]);
  });
});
