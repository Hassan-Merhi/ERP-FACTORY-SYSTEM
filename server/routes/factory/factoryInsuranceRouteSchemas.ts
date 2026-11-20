/**
 * Request schemas for the Insurance write routes. Every route resolves its
 * company with resolveRequestCompanyId(req), which reads an optional
 * body/query companyId and refuses one that is not the session company, so
 * each schema accepts that field. The handlers keep their own value checks
 * and messages; these schemas check shape and reject unknown fields.
 */
import { z } from "zod";
import { insertInsuranceMemberSchema } from "@shared/schema";
import { idParams, type RequestSchemas } from "../../lib/validateRequest";

/** Read by resolveRequestCompanyId; only the session company passes. */
const companyId = z.union([z.number(), z.string()]).nullable().optional();
const companyQuery = z.strictObject({ companyId: z.string().optional() });
const companyOnlyBody = z.union([z.undefined(), z.strictObject({ companyId })]);

export const extraChargeInput = {
  query: companyQuery,
  body: z.strictObject({
    voucherDate: z.string(),
    amount: z.string(),
    debitAccountId: z.number(),
    creditAccountId: z.number(),
    notes: z.string().optional(),
    clientRequestId: z.string(),
    companyId,
  }),
} satisfies RequestSchemas;

export const createMemberInput = {
  query: companyQuery,
  body: insertInsuranceMemberSchema.omit({ companyId: true }).extend({ companyId }).strict(),
} satisfies RequestSchemas;

export const updateMemberInput = {
  params: idParams,
  query: companyQuery,
  body: insertInsuranceMemberSchema.partial().omit({ companyId: true }).extend({ companyId }).strict(),
} satisfies RequestSchemas;

export const memberActionInput = {
  params: idParams,
  query: companyQuery,
  body: companyOnlyBody,
} satisfies RequestSchemas;

/** Multipart form fields (strings); the workbook itself is req.file. */
export const importPreviewInput = {
  query: companyQuery,
  body: z.strictObject({ year: z.string().optional(), companyId: z.string().optional() }),
} satisfies RequestSchemas;

export const importApplyInput = {
  query: companyQuery,
  body: z.strictObject({
    rows: z.array(
      z.strictObject({
        sheetName: z.string(),
        monthStart: z.string(),
        name: z.string(),
        amount: z.string(),
        startDate: z.string(),
        nationality: z.string().optional(),
        positionWorking: z.string().optional(),
        insuranceNumber: z.string().optional(),
        dob: z.string().optional(),
        notes: z.string().optional(),
      })
    ),
    companyId,
  }),
} satisfies RequestSchemas;

export const clearAllInput = {
  query: companyQuery,
  body: z.union([z.undefined(), z.strictObject({ confirmation: z.string().optional(), companyId })]),
} satisfies RequestSchemas;

export const generateInput = {
  query: companyQuery,
  body: z.strictObject({ month: z.number(), year: z.number(), companyId }),
} satisfies RequestSchemas;

export const journalDirectionApplyInput = {
  query: companyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({ confirm: z.boolean().optional(), planHash: z.string().optional(), companyId }),
  ]),
} satisfies RequestSchemas;
