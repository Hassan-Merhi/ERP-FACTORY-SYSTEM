import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { users, userCompanyRoles } from "@shared/schema";
import { verifyPasswordBcryptOnly } from "../helpers/passwordHelpers";

/** All factory attendance locks use the server's Beirut calendar date, including DST changes. */
export function factoryAttendanceToday(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isValidAttendanceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export type AttendanceAdminCredentials = {
  adminUsername?: unknown;
  adminPassword?: unknown;
};

export type AttendanceApprover = { id: string; username: string };

/**
 * Returns undefined after sending a rejection, null for same-day records,
 * and the verifying Admin for older dates. Each save verifies the password
 * itself; no reusable override/session flag is issued.
 */
export async function requireAttendanceEditApproval(
  req: Request,
  res: Response,
  companyId: number,
  dates: unknown[],
  credentials: AttendanceAdminCredentials | undefined
): Promise<AttendanceApprover | null | undefined> {
  if (dates.length === 0 || dates.some((date) => !isValidAttendanceDate(date))) {
    res.status(400).json({ message: "Invalid attendance date" });
    return undefined;
  }
  const today = factoryAttendanceToday();
  if (dates.some((date) => (date as string) > today)) {
    res.status(400).json({ message: "Future attendance dates cannot be edited" });
    return undefined;
  }
  const olderDates = [...new Set(dates.filter((date) => (date as string) < today) as string[])];
  if (!olderDates.length) return null;

  const username = typeof credentials?.adminUsername === "string" ? credentials.adminUsername.trim() : "";
  const password = typeof credentials?.adminPassword === "string" ? credentials.adminPassword : "";
  if (!username || !password) {
    res.status(403).json({
      code: "ATTENDANCE_ADMIN_APPROVAL_REQUIRED",
      requiresAdminApproval: true,
      dates: olderDates,
      message: "Editing earlier attendance requires an Admin username and password",
    });
    return undefined;
  }
  if (username.length > 191 || password.length > 500) {
    res.status(401).json({ message: "Invalid Admin credentials" });
    return undefined;
  }

  const [admin] = await db
    .select({ id: users.id, username: users.username, password: users.password, active: users.active, role: userCompanyRoles.role })
    .from(users)
    .innerJoin(userCompanyRoles, and(eq(userCompanyRoles.userId, users.id), eq(userCompanyRoles.companyId, companyId)))
    .where(eq(users.username, username))
    .limit(1);

  if (!admin || !admin.active || admin.role !== "Admin" ||
      !(await verifyPasswordBcryptOnly(password, admin.password))) {
    res.status(401).json({ message: "Invalid Admin credentials for this factory company" });
    return undefined;
  }
  return { id: admin.id, username: admin.username };
}
