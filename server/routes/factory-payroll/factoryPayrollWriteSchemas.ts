/**
 * Input schemas for the factory payroll write routes (./*.ts).
 *
 * The handlers keep their own checks (and messages) for missing or
 * unparseable values, so those fields stay optional here. Amounts are read
 * with parseMoneyInput and ids with Number/parseId, so numbers and strings are
 * both accepted.
 */
import { z } from "zod";
import { emptyBody, idParams, type RequestSchemas } from "../../lib/validateRequest";

const numberOrString = z.union([z.number(), z.string()]);
const money = numberOrString.nullable().optional();

// DELETE and undo read an optional ?companyId (the company scope stage
// refuses one that is not the bound company).
const companyQuery = z.strictObject({ companyId: z.string().optional() });

export const updateFactoryPayrollInput = {
  params: idParams,
  query: z.strictObject({}),
  body: z.strictObject({
    bonuses: money,
    otherBonuses: money,
    deductions: money,
    advances: money,
    overtimeHours: money,
    overtimePay: money,
    notes: z.string().nullable().optional(),
    status: z.string().optional(),
    paymentSource: z.string().nullable().optional(),
    paymentDate: z.string().nullable().optional(),
    paymentReference: z.string().nullable().optional(),
    effectiveDate: z.string().nullable().optional(),
    cashAccountId: numberOrString.nullable().optional(),
  }),
} satisfies RequestSchemas;

export const factoryPayrollActionInput = {
  params: idParams,
  query: companyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const productionBonusDecisionInput = {
  params: idParams,
  query: z.strictObject({}),
  body: z.strictObject({
    decision: z.string().optional(),
    items: z.array(z.strictObject({ runId: numberOrString, workerId: numberOrString })).optional(),
    all: z.boolean().optional(),
    note: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

// companyId must be the bound company (company scope stage); the handler
// re-checks it is a positive integer.
export const factoryPayrollExportInput = {
  query: z.strictObject({}),
  body: z.strictObject({
    companyId: numberOrString.optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
} satisfies RequestSchemas;
