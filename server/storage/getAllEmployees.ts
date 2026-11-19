// Extracted from ./employees.ts to keep that module under the source-size cap.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import * as schema from "@shared/schema";
import { type Employee, type InsertEmployee } from "@shared/schema";
import { MoneyDecimal, toMoney } from "../lib/money";
import { loadEmployeeLedgerAmounts } from "../services/accounting/employeeLedgerAmounts";

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
  const [employees, ledgerAmounts] = await Promise.all([
    getAllEmployees(companyId),
    loadEmployeeLedgerAmounts(companyId),
  ]);
  return employees.map((employee) => {
    const amounts = ledgerAmounts.get(employee.id);
    const currentBalance = amounts?.currentBalance ?? "0.00";
    return {
      ...employee,
      currentBalance,
      calculatedBalance: currentBalance,
      totalDeposits: amounts?.totalDeposits ?? "0.00",
      totalWithdrawals: amounts?.totalWithdrawals ?? "0.00",
    };
  });
}

export async function getEmployeeByCode(code: string): Promise<Employee | undefined> {
  const [employee] = await db.select().from(schema.employees).where(eq(schema.employees.code, code));
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
  // The employee opening form has always accepted a signed amount:
  // positive means we owe the employee (Cr); negative is an advance (Dr).
  // Store the unsigned opening plus its actual side so the accounting engine,
  // Payroll, Accounts and exports all interpret the same entry.
  const signedOpening = toMoney(employee.openingBalance);
  const openingBalance = signedOpening.abs().toFixed(2);
  const openingSide = signedOpening.isNegative() ? "Dr" : "Cr";
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.employees)
      .values([
        {
          ...employee,
          openingBalance,
          currentBalance: signedOpening.toFixed(2),
        },
      ])
      .returning();
    if (!created) throw new Error("Employee creation did not return an employee");
    // Runtime side column exists outside Drizzle's base employee model.
    // Keep this update in the insertion transaction so it is all-or-nothing.
    await tx.execute(sql`
      UPDATE employees SET opening_balance_side = ${openingSide}
      WHERE id = ${created.id} AND company_id = ${created.companyId}
    `);
    return { ...created, openingBalance, currentBalance: signedOpening.toFixed(2) };
  });
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

    const employeeBalance = toMoney(employee.currentBalance);

    const [linkedAccount] = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(eq(schema.ledgerAccounts.code, employee.code), eq(schema.ledgerAccounts.companyId, employee.companyId))
      );

    let ledgerBalance = new MoneyDecimal(0);

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

      const openingBalance = toMoney(linkedAccount.openingBalance);
      const openingSide = linkedAccount.openingBalanceSide || "Dr";
      ledgerBalance = openingSide === "Dr" ? openingBalance : openingBalance.negated();
    }

    // Any balance that is not zero at cents needs confirmation: the old "> 0.01"
    // test let a one-cent balance through as if it were zero.
    const nonZero = (value: InstanceType<typeof MoneyDecimal>) => !value.toDecimalPlaces(2).isZero();
    if (!forceDelete && (nonZero(employeeBalance) || nonZero(ledgerBalance))) {
      return {
        success: false,
        message: "Employee or linked account has a non-zero balance. Admin confirmation required.",
        employeeBalance: employeeBalance.toNumber(),
        ledgerBalance: ledgerBalance.toNumber(),
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
