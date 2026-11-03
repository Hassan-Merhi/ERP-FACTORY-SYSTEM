import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const { selectMock, passwordCheckMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  passwordCheckMock: vi.fn(),
}));

vi.mock("../server/db", () => ({ db: { select: selectMock } }));
vi.mock("../server/routes/helpers/passwordHelpers", () => ({
  verifyPasswordBcryptOnly: passwordCheckMock,
}));

import {
  factoryAttendanceToday,
  requireAttendanceEditApproval,
} from "../server/routes/factory/attendanceEditPolicy";

function pastAttendanceDate(): string {
  const [year, month, day] = factoryAttendanceToday().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function requester(role: string): Request {
  return { session: { userId: "owner-user", currentRole: role }, user: { id: "owner-user" } } as unknown as Request;
}

function response() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return res as unknown as Response & typeof res;
}

describe("Factory attendance historical edit lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires an Admin password for historical edits by Owners (no direct override)", async () => {
    const res = response();
    const result = await requireAttendanceEditApproval(
      requester("Owner"), res, 42, [pastAttendanceDate()], undefined
    );

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "ATTENDANCE_ADMIN_APPROVAL_REQUIRED",
      requiresAdminApproval: true,
    }));
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("still allows same-day attendance without approval", async () => {
    const res = response();
    const result = await requireAttendanceEditApproval(
      requester("Owner"), res, 42, [factoryAttendanceToday()], undefined
    );

    expect(result).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("accepts a separately verified active company Admin for historical attendance", async () => {
    const admin = { id: "admin-user", username: "factory-admin", active: true, role: "Admin", password: "hash" };
    const limit = vi.fn().mockResolvedValue([admin]);
    const where = vi.fn().mockReturnValue({ limit });
    const innerJoin = vi.fn().mockReturnValue({ where });
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ innerJoin }) });
    passwordCheckMock.mockResolvedValue(true);
    const res = response();

    const result = await requireAttendanceEditApproval(
      requester("Owner"), res, 42, [pastAttendanceDate()],
      { adminUsername: "factory-admin", adminPassword: "valid-password" }
    );

    expect(result).toEqual({
      id: "admin-user",
      username: "factory-admin",
      authorizationMethod: "admin_password",
    });
    expect(passwordCheckMock).toHaveBeenCalledWith("valid-password", "hash");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects an Owner account presented as the approving Admin", async () => {
    const owner = { id: "owner-user", username: "factory-owner", active: true, role: "Owner", password: "hash" };
    const limit = vi.fn().mockResolvedValue([owner]);
    const where = vi.fn().mockReturnValue({ limit });
    const innerJoin = vi.fn().mockReturnValue({ where });
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ innerJoin }) });
    const res = response();

    const result = await requireAttendanceEditApproval(
      requester("Owner"), res, 42, [pastAttendanceDate()],
      { adminUsername: "factory-owner", adminPassword: "password" }
    );

    expect(result).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(passwordCheckMock).not.toHaveBeenCalled();
  });
});
