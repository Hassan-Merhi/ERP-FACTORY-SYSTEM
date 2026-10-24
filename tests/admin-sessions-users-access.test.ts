import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/routes/auth/sessionRepository", () => ({
  sessionRepository: {
    listActiveSessions: vi.fn(),
    getLatestGeoByIp: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteOtherUserSessions: vi.fn(),
    getLoginHistory: vi.fn(),
  },
}));

const { sessionRepository } = await import("../server/routes/auth/sessionRepository");
const { sessionService } = await import("../server/routes/auth/sessionService");

const repo = vi.mocked(sessionRepository);

function storedSession(companyId: number, role: string) {
  return {
    sid: "target-session",
    expire: new Date(Date.now() + 600_000),
    sess: { userId: "target-user", currentCompanyId: companyId, currentRole: role },
  };
}

describe("Sessions & Users company admin permissions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    repo.listActiveSessions.mockResolvedValue([]);
    repo.getLatestGeoByIp.mockResolvedValue([]);
    repo.getLoginHistory.mockResolvedValue([]);
    repo.deleteSession.mockResolvedValue({} as never);
  });

  it.each(["Admin", "Owner"])("limits %s session listing to the selected company", async (role) => {
    await sessionService.list({ userId: "admin-user", role, currentSid: "current", companyId: 5 });
    expect(repo.listActiveSessions).toHaveBeenCalledWith("admin-user", true, 5);
  });

  it("preserves Developer cross-company session access", async () => {
    await sessionService.list({ userId: "dev-user", role: "Developer", currentSid: "current", companyId: 5 });
    expect(repo.listActiveSessions).toHaveBeenCalledWith("dev-user", true, undefined);
  });

  it("does not grant ordinary users a company-wide session listing", async () => {
    await sessionService.list({ userId: "employee", role: "Employee", currentSid: "current", companyId: 5 });
    expect(repo.listActiveSessions).toHaveBeenCalledWith("employee", false, 5);
  });

  it("refuses company admin listing without a selected company", async () => {
    await expect(sessionService.list({ userId: "admin-user", role: "Admin", currentSid: "current", companyId: undefined }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(repo.listActiveSessions).not.toHaveBeenCalled();
  });

  it.each(["Admin", "Owner"])("allows %s to revoke non-Developer sessions in their own company", async (role) => {
    repo.getSession.mockResolvedValue(storedSession(5, "Employee"));
    await expect(sessionService.revoke({ sid: "target-session", userId: "admin-user", role, companyId: 5 }))
      .resolves.toEqual({ ok: true });
    expect(repo.deleteSession).toHaveBeenCalledWith("target-session");
  });

  it.each([
    { targetCompanyId: 6, targetRole: "Employee" },
    { targetCompanyId: 5, targetRole: "Developer" },
  ])("prevents company admins from revoking sessions outside their scope ($targetCompanyId, $targetRole)", async ({ targetCompanyId, targetRole }) => {
    repo.getSession.mockResolvedValue(storedSession(targetCompanyId, targetRole));
    await expect(sessionService.revoke({ sid: "target-session", userId: "admin-user", role: "Admin", companyId: 5 }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(repo.deleteSession).not.toHaveBeenCalled();
  });

  it("preserves user's right to revoke their own session", async () => {
    repo.getSession.mockResolvedValue(storedSession(5, "Employee"));
    await expect(sessionService.revoke({ sid: "target-session", userId: "target-user", role: "Employee", companyId: 5 }))
      .resolves.toEqual({ ok: true });
  });

  it("requires a company for admins reading login history", async () => {
    await expect(sessionService.loginHistory("Admin", undefined))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(repo.getLoginHistory).not.toHaveBeenCalled();
  });
});
