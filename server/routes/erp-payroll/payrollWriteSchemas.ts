/**
 * Input schemas for the ERP payroll write routes (./*.ts).
 *
 * The handlers keep their own presence and amount checks (and their messages),
 * so fields they check for are optional here. Money and id fields are parsed
 * by the handlers (parseMoneyInput / Number / parseInt), so both numbers and
 * strings are accepted, as callers send either.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);
const money = numberOrString.nullable().optional();
const id = numberOrString.nullable().optional();
const notes = z.string().nullable().optional();
const date = z.string().nullable().optional();

/**
 * Added by client/src/lib/accountingRequestIdentity.ts; claimed by
 * operationalVoucherRequestBoundary and read by erpRequestSourceId.
 */
const clientRequestId = z.string().optional();

// Run handlers parse the id with parseInt and answer 404 for no match.
const runIdParams = z.strictObject({ id: stringParam });

export const autoCalculateBonusesInput = {
  query: emptyQuery,
  body: z.strictObject({
    startDate: date,
    endDate: date,
    pctLocationId: id,
    pctSourceCompanyId: id,
  }),
} satisfies RequestSchemas;

export const singleEmployeeAdjustmentInput = {
  query: emptyQuery,
  body: z.strictObject({ employeeId: id, amount: money, date, notes, clientRequestId }),
} satisfies RequestSchemas;

export const withdrawEmployeeInput = {
  query: emptyQuery,
  body: z.strictObject({
    employeeId: id,
    amount: money,
    paymentAccountType: z.string().nullable().optional(),
    paymentAccountId: id,
    // Older callers sent only a bank account id.
    bankAccountId: id,
    date,
    notes,
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const payWorkerInput = {
  query: emptyQuery,
  body: z.strictObject({ employeeId: id, amount: money, bankAccountId: id, date, notes, clientRequestId }),
} satisfies RequestSchemas;

const employeeAmountRows = z
  .array(z.strictObject({ employeeId: id, amount: money }))
  .nullable()
  .optional();

export const bulkBonusInput = {
  query: emptyQuery,
  body: z.strictObject({ bonuses: employeeAmountRows, date, notes, clientRequestId }),
} satisfies RequestSchemas;

export const bulkDepositInput = {
  query: emptyQuery,
  body: z.strictObject({ deposits: employeeAmountRows, date, notes, clientRequestId }),
} satisfies RequestSchemas;

export const bulkWithdrawInput = {
  query: emptyQuery,
  body: z.strictObject({
    withdrawals: employeeAmountRows,
    date,
    notes,
    paymentAccountType: z.string().nullable().optional(),
    paymentAccountId: id,
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const bulkPayWorkersInput = {
  query: emptyQuery,
  body: z.strictObject({
    payments: z
      .array(
        z.strictObject({
          employeeId: id,
          amount: money,
          workerId: z.unknown().optional(), // sent by client/src/pages/payroll/usePayrollModelPart3.ts; not used
        })
      )
      .nullable()
      .optional(),
    paymentAccountType: z.string().nullable().optional(),
    paymentAccountId: id,
    // Older callers sent only a bank account id.
    bankAccountId: id,
    date,
    notes,
    clientRequestId,
  }),
} satisfies RequestSchemas;

const payrollRunItem = z.strictObject({
  employeeId: z.number(),
  employeeName: z.string(),
  groupName: z.string().nullable().optional(),
  baseSalary: money,
  deduction: money,
  payrollDeduction: money,
  netPay: money,
});

export const createPayrollRunInput = {
  query: emptyQuery,
  body: z.strictObject({ date, notes, items: z.array(payrollRunItem).nullable().optional() }),
} satisfies RequestSchemas;

export const updatePayrollRunInput = {
  params: runIdParams,
  query: emptyQuery,
  body: z.strictObject({
    action: z.string().nullable().optional(),
    items: z.array(payrollRunItem).nullable().optional(),
    paymentAccountId: id,
    date,
    notes,
    clientRequestId,
  }),
} satisfies RequestSchemas;

export const payrollRunActionInput = {
  params: runIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
