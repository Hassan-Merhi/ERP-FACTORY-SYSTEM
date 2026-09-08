import { eq, and, asc, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import * as schema from "@shared/schema";
import type { Employee, InsertEmployee } from "@shared/schema";

// Employees

export async function getAllEmployees(companyId: number): Promise<Employee[]> {
  const employees = await db
    .select()
    .from(schema.employees)
    .where(and(eq(schema.employees.companyId, companyId), isNull(schema.employees.deletedAt)))
    .orderBy(asc(schema.employees.firstName), asc(schema.employees.lastName));
  return employees.map((emp) => ({
    ...emp,
    firstName:
      (
        emp as unknown as {
          id: number;
          companyId: number;
          code: string;
          firstName: string;
          lastName: string;
          email: string | null;
          phone: string | null;
          joinDate: string;
          department: string | null;
          employeeType: string;
          monthlySalary: string;
          openingBalance: string | null;
          currentBalance: string;
          totalDeposits: string;
          totalWithdrawals: string;
          active: boolean;
          salesBonusPct: string | null;
          salesBonusPctSourceCompanyId: number | null;
          salesBonusPctLocationId: number | null;
          balesBonusRate: string | null;
          deletedAt: Date | null;
          createdAt: Date;
        } & { firstName: unknown }
      ).firstName ||
      (
        emp as unknown as {
          id: number;
          companyId: number;
          code: string;
          firstName: string;
          lastName: string;
          email: string | null;
          phone: string | null;
          joinDate: string;
          department: string | null;
          employeeType: string;
          monthlySalary: string;
          openingBalance: string | null;
          currentBalance: string;
          totalDeposits: string;
          totalWithdrawals: string;
          active: boolean;
          salesBonusPct: string | null;
          salesBonusPctSourceCompanyId: number | null;
          salesBonusPctLocationId: number | null;
          balesBonusRate: string | null;
          deletedAt: Date | null;
          createdAt: Date;
        } & { first_name: unknown }
      ).first_name,
    lastName:
      (
        emp as unknown as {
          id: number;
          companyId: number;
          code: string;
          firstName: string;
          lastName: string;
          email: string | null;
          phone: string | null;
          joinDate: string;
          department: string | null;
          employeeType: string;
          monthlySalary: string;
          openingBalance: string | null;
          currentBalance: string;
          totalDeposits: string;
          totalWithdrawals: string;
          active: boolean;
          salesBonusPct: string | null;
          salesBonusPctSourceCompanyId: number | null;
          salesBonusPctLocationId: number | null;
          balesBonusRate: string | null;
          deletedAt: Date | null;
          createdAt: Date;
        } & { lastName: unknown }
      ).lastName ||
      (
        emp as unknown as {
          id: number;
          companyId: number;
          code: string;
          firstName: string;
          lastName: string;
          email: string | null;
          phone: string | null;
          joinDate: string;
          department: string | null;
          employeeType: string;
          monthlySalary: string;
          openingBalance: string | null;
          currentBalance: string;
          totalDeposits: string;
          totalWithdrawals: string;
          active: boolean;
          salesBonusPct: string | null;
          salesBonusPctSourceCompanyId: number | null;
          salesBonusPctLocationId: number | null;
          balesBonusRate: string | null;
          deletedAt: Date | null;
          createdAt: Date;
        } & { last_name: unknown }
      ).last_name,
  })) as Employee[];
}

export async function getEmployeesWithBalances(
  companyId: number
): Promise<Array<Employee & { calculatedBalance: string }>> {
  const employees = await getAllEmployees(companyId);
  return employees.map((employee) => {
    const calculatedBalance = parseFloat(employee.currentBalance || "0");
    return {
      ...employee,
      calculatedBalance: calculatedBalance.toFixed(2),
    };
  });
}

export async function getEmployeeByCode(code: string): Promise<Employee | undefined> {
  const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.code, code));
  return employee;
}

export async function getEmployeeById(id: number): Promise<Employee | undefined> {
  const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.id, id));
  return employee;
}

/**
 * `code` is optional on the Zod insert schema — the route derives one from the
 * employee's name when the client omits it — but the column is NOT NULL and
 * unique. Requiring it here means the route's allocation has to happen before
 * the call rather than being assumed to have happened.
 */
export type CreateEmployeeInput = InsertEmployee & { code: string };

export async function createEmployee(employee: CreateEmployeeInput): Promise<Employee> {
  const [created] = await db.insert(schema.employees).values([employee]).returning();
  return created;
}

export async function updateEmployee(
  id: number,
  companyId: number,
  updates: Partial<InsertEmployee>
): Promise<Employee | undefined> {
  const [updated] = await db
    .update(schema.employees)
    .set(updates)
    .where(and(eq(schema.employees.id, id), eq(schema.employees.companyId, companyId)))
    .returning();
  return updated;
}

export async function deleteEmployee(
  id: number,
  forceDelete: boolean = false
): Promise<{ success: boolean; message?: string; employeeBalance?: number; ledgerBalance?: number }> {
  return await db.transaction(async (tx) => {
    const [employee] = await tx.select().from(schema.employees).where(eq(schema.employees.id, id));

    if (!employee) {
      return { success: false, message: "Employee not found" };
    }

    const salaryAdvances = await tx
      .select()
      .from(schema.salaryAdvances)
      .where(eq(schema.salaryAdvances.employeeId, id))
      .limit(1);

    if (salaryAdvances.length > 0) {
      return {
        success: false,
        message: "Cannot delete employee with salary advances. Please remove all salary advances first.",
      };
    }

    const employeeBalance = parseFloat(employee.currentBalance || "0");

    const [linkedAccount] = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(eq(schema.ledgerAccounts.code, employee.code), eq(schema.ledgerAccounts.companyId, employee.companyId))
      );

    let ledgerBalance = 0;

    if (linkedAccount) {
      const voucherEntries = await tx
        .select({ id: schema.voucherEntries.id })
        .from(schema.voucherEntries)
        .where(eq(schema.voucherEntries.ledgerAccountId, linkedAccount.id))
        .limit(1);

      if (voucherEntries.length > 0) {
        return {
          success: false,
          message: "Cannot delete employee. The linked ledger account has transaction history.",
        };
      }

      const openingBalance = parseFloat(linkedAccount.openingBalance || "0");
      const openingSide = linkedAccount.openingBalanceSide || "Dr";
      ledgerBalance = openingSide === "Dr" ? openingBalance : -openingBalance;
    }

    if (!forceDelete && (Math.abs(employeeBalance) > 0.01 || Math.abs(ledgerBalance) > 0.01)) {
      return {
        success: false,
        message: "Employee or linked account has a non-zero balance. Admin confirmation required.",
        employeeBalance: employeeBalance,
        ledgerBalance: ledgerBalance,
      };
    }

    const now = new Date();

    if (linkedAccount) {
      await tx
        .update(schema.ledgerAccounts)
        .set({ deletedAt: now, active: false })
        .where(eq(schema.ledgerAccounts.id, linkedAccount.id));
    }

    await tx.delete(schema.employeeGroupMembers).where(eq(schema.employeeGroupMembers.employeeId, id));

    await tx.update(schema.employees).set({ deletedAt: now, active: false }).where(eq(schema.employees.id, id));

    return { success: true };
  });
}

// Employee Groups

/** A group row with the "Employee" default applied for legacy rows that predate the column. */
export type EmployeeGroupWithType = schema.EmployeeGroup & { groupType: string };

export async function getAllEmployeeGroups(companyId: number): Promise<EmployeeGroupWithType[]> {
  const results = await db
    .select()
    .from(schema.employeeGroups)
    .where(eq(schema.employeeGroups.companyId, companyId))
    .orderBy(asc(schema.employeeGroups.name));
  return results.map((g) => ({
    ...g,
    groupType: g.groupType || "Employee",
  }));
}

export async function getEmployeeGroupById(id: number): Promise<schema.EmployeeGroup | undefined> {
  const [group] = await db.select().from(schema.employeeGroups).where(eq(schema.employeeGroups.id, id));
  return group;
}

export async function createEmployeeGroup(group: schema.InsertEmployeeGroup): Promise<schema.EmployeeGroup> {
  const [created] = await db.insert(schema.employeeGroups).values(group).returning();
  return created;
}

export async function updateEmployeeGroup(
  id: number,
  updates: Partial<schema.InsertEmployeeGroup>
): Promise<schema.EmployeeGroup> {
  const [updated] = await db
    .update(schema.employeeGroups)
    .set(updates)
    .where(eq(schema.employeeGroups.id, id))
    .returning();
  return updated;
}

export async function deleteEmployeeGroup(id: number): Promise<void> {
  await db.delete(schema.employeeGroupMembers).where(eq(schema.employeeGroupMembers.employeeGroupId, id));
  await db.delete(schema.employeeGroups).where(eq(schema.employeeGroups.id, id));
}

/**
 * A group membership joined to its employee. The employee columns come through
 * a LEFT JOIN, so every one of them is nullable when the employee row is gone.
 */
export interface EmployeeGroupMember {
  id: number;
  employeeId: number | null;
  employeeCode: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  department: string | null;
}

export async function getEmployeeGroupMembers(groupId: number): Promise<EmployeeGroupMember[]> {
  const results = await db
    .select({
      id: schema.employeeGroupMembers.id,
      employeeId: schema.employees.id,
      employeeCode: schema.employees.code,
      firstName: schema.employees.firstName,
      lastName: schema.employees.lastName,
      email: schema.employees.email,
      department: schema.employees.department,
    })
    .from(schema.employeeGroupMembers)
    .leftJoin(schema.employees, eq(schema.employeeGroupMembers.employeeId, schema.employees.id))
    .where(eq(schema.employeeGroupMembers.employeeGroupId, groupId));
  return results;
}

export async function addEmployeeToGroup(groupId: number, employeeId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(schema.employeeGroupMembers)
    .where(
      and(
        eq(schema.employeeGroupMembers.employeeGroupId, groupId),
        eq(schema.employeeGroupMembers.employeeId, employeeId)
      )
    );

  if (!existing) {
    await db.insert(schema.employeeGroupMembers).values({
      employeeGroupId: groupId,
      employeeId: employeeId,
    });
  }
}

export async function removeEmployeeFromGroup(groupId: number, employeeId: number): Promise<void> {
  await db
    .delete(schema.employeeGroupMembers)
    .where(
      and(
        eq(schema.employeeGroupMembers.employeeGroupId, groupId),
        eq(schema.employeeGroupMembers.employeeId, employeeId)
      )
    );
}

// Salary Advances

/**
 * A salary advance with its employee's display fields resolved.
 *
 * `amount`/`remainingBalance` are `decimal` columns and therefore arrive as
 * strings. `employeeCode` is normalized to "" and `employeeName` is always
 * populated, so neither is nullable on this shape even though the underlying
 * LEFT JOIN can miss.
 */
export interface SalaryAdvanceWithEmployee {
  id: number;
  companyId: number;
  employeeId: number;
  advanceDate: string;
  amount: string;
  remainingBalance: string;
  voucherId: number | null;
  notes: string | null;
  fullyPaid: boolean;
  isOpeningBalance: boolean;
  createdAt: Date;
  employeeCode: string;
  employeeFirstName: string | null;
  employeeLastName: string | null;
  employeeName: string;
}

export async function getAllSalaryAdvances(companyId: number): Promise<SalaryAdvanceWithEmployee[]> {
  const rows = await db
    .select({
      id: schema.salaryAdvances.id,
      companyId: schema.salaryAdvances.companyId,
      employeeId: schema.salaryAdvances.employeeId,
      advanceDate: schema.salaryAdvances.advanceDate,
      amount: schema.salaryAdvances.amount,
      remainingBalance: schema.salaryAdvances.remainingBalance,
      voucherId: schema.salaryAdvances.voucherId,
      notes: schema.salaryAdvances.notes,
      fullyPaid: schema.salaryAdvances.fullyPaid,
      isOpeningBalance: schema.salaryAdvances.isOpeningBalance,
      createdAt: schema.salaryAdvances.createdAt,
      employeeCode: schema.employees.code,
      employeeFirstName: schema.employees.firstName,
      employeeLastName: schema.employees.lastName,
    })
    .from(schema.salaryAdvances)
    .leftJoin(schema.employees, eq(schema.salaryAdvances.employeeId, schema.employees.id))
    .where(eq(schema.salaryAdvances.companyId, companyId))
    .orderBy(sql`${schema.salaryAdvances.advanceDate} DESC`);

  return rows.map((r) => ({
    ...r,
    employeeName: `${r.employeeFirstName ?? ""} ${r.employeeLastName ?? ""}`.trim() || `Employee #${r.employeeId}`,
    employeeCode: r.employeeCode ?? "",
  }));
}

export async function getSalaryAdvanceById(id: number): Promise<schema.SalaryAdvance | undefined> {
  const [advance] = await db.select().from(schema.salaryAdvances).where(eq(schema.salaryAdvances.id, id));
  return advance;
}

export async function getSalaryAdvancesByEmployee(employeeId: number): Promise<schema.SalaryAdvance[]> {
  return await db
    .select()
    .from(schema.salaryAdvances)
    .where(eq(schema.salaryAdvances.employeeId, employeeId))
    .orderBy(sql`${schema.salaryAdvances.advanceDate} DESC`);
}

export async function getUnpaidSalaryAdvancesByEmployee(employeeId: number): Promise<schema.SalaryAdvance[]> {
  return await db
    .select()
    .from(schema.salaryAdvances)
    .where(and(eq(schema.salaryAdvances.employeeId, employeeId), eq(schema.salaryAdvances.fullyPaid, false)))
    .orderBy(sql`${schema.salaryAdvances.advanceDate}`);
}

export async function createSalaryAdvance(advance: schema.InsertSalaryAdvance): Promise<schema.SalaryAdvance> {
  const [newAdvance] = await db.insert(schema.salaryAdvances).values(advance).returning();
  return newAdvance;
}

export async function updateSalaryAdvance(
  id: number,
  updates: Partial<schema.InsertSalaryAdvance>
): Promise<schema.SalaryAdvance> {
  const [advance] = await db
    .update(schema.salaryAdvances)
    .set(updates)
    .where(eq(schema.salaryAdvances.id, id))
    .returning();
  return advance;
}

export async function deleteSalaryAdvance(id: number): Promise<void> {
  await db.delete(schema.salaryAdvanceDeductions).where(eq(schema.salaryAdvanceDeductions.salaryAdvanceId, id));
  await db.delete(schema.salaryAdvances).where(eq(schema.salaryAdvances.id, id));
}

// Salary Advance Deductions

export async function getSalaryAdvanceDeductions(salaryAdvanceId: number): Promise<schema.SalaryAdvanceDeduction[]> {
  return await db
    .select()
    .from(schema.salaryAdvanceDeductions)
    .where(eq(schema.salaryAdvanceDeductions.salaryAdvanceId, salaryAdvanceId))
    .orderBy(schema.salaryAdvanceDeductions.payrollMonth);
}

export async function createSalaryAdvanceDeduction(
  deduction: schema.InsertSalaryAdvanceDeduction
): Promise<schema.SalaryAdvanceDeduction> {
  const [newDeduction] = await db.insert(schema.salaryAdvanceDeductions).values(deduction).returning();
  return newDeduction;
}

// Employee Bale Rates

export async function getEmployeeBaleRates(employeeId: number, companyId: number): Promise<schema.EmployeeBaleRate[]> {
  return await db
    .select()
    .from(schema.employeeBaleRates)
    .where(and(eq(schema.employeeBaleRates.employeeId, employeeId), eq(schema.employeeBaleRates.companyId, companyId)));
}

export async function setEmployeeBaleRates(
  employeeId: number,
  companyId: number,
  rates: { locationId: number; rate: string; sourceCompanyId?: number | null }[]
): Promise<void> {
  await db
    .delete(schema.employeeBaleRates)
    .where(and(eq(schema.employeeBaleRates.employeeId, employeeId), eq(schema.employeeBaleRates.companyId, companyId)));
  if (rates.length > 0) {
    await db.insert(schema.employeeBaleRates).values(
      rates.map((r) => ({
        companyId,
        employeeId,
        locationId: r.locationId,
        rate: r.rate,
        sourceCompanyId: r.sourceCompanyId ?? null,
      }))
    );
  }
}

export async function getEmployeeBalePctRates(
  employeeId: number,
  companyId: number
): Promise<schema.EmployeeBalePctRate[]> {
  return await db
    .select()
    .from(schema.employeeBalePctRates)
    .where(
      and(eq(schema.employeeBalePctRates.employeeId, employeeId), eq(schema.employeeBalePctRates.companyId, companyId))
    );
}

export async function setEmployeeBalePctRates(
  employeeId: number,
  companyId: number,
  rates: { locationId: number; pct: string; sourceCompanyId?: number | null }[]
): Promise<void> {
  await db
    .delete(schema.employeeBalePctRates)
    .where(
      and(eq(schema.employeeBalePctRates.employeeId, employeeId), eq(schema.employeeBalePctRates.companyId, companyId))
    );
  if (rates.length > 0) {
    await db.insert(schema.employeeBalePctRates).values(
      rates.map((r) => ({
        companyId,
        employeeId,
        locationId: r.locationId,
        pct: r.pct,
        sourceCompanyId: r.sourceCompanyId ?? null,
      }))
    );
  }
}
