import { z } from "zod";
import { emptyBody, emptyQuery, idParams, stringParam, type RequestSchemas } from "../../lib/validateRequest";
import { insertSalaryAdvanceDeductionSchema } from "@shared/schema";

export const reassignAdvanceWorkerInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ employeeId: z.number().int().positive() }),
} satisfies RequestSchemas;

// The handler still runs insertSalaryAdvanceSchema for the amount/date rules;
// companyId and remainingBalance are set by the server.
export const createSalaryAdvanceInput = {
  query: emptyQuery,
  body: z.strictObject({
    employeeId: z.number(),
    amount: z.string(),
    advanceDate: z.string(),
    cashAccountId: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
    isOpeningBalance: z.boolean().nullable().optional(),
    // Added by client/src/lib/accountingRequestIdentity.ts; read by erpRequestSourceId.
    clientRequestId: z.string().optional(),
  }),
} satisfies RequestSchemas;

export const salaryAdvanceDeductionInput = {
  params: idParams,
  query: emptyQuery,
  body: insertSalaryAdvanceDeductionSchema.omit({ salaryAdvanceId: true }).strict(),
} satisfies RequestSchemas;

// The delete handler parses the id with parseInt.
export const deleteSalaryAdvanceInput = {
  params: z.strictObject({ id: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const reconcileSalaryAdvancesInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
