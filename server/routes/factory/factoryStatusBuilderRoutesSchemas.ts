import { z } from "zod";
import { idParams, positiveIntParam, type RequestSchemas } from "../../lib/validateRequest";

// resolveRequestCompanyId reads companyId from the body or the query string and
// requires it to match the session's company, so every route accepts it in both.
const companyId = z.union([z.number(), z.string()]).nullable().optional();
const companyQuery = z.strictObject({ companyId: z.string().optional() });
const companyOnlyBody = z.strictObject({ companyId }).optional();

const sortOrder = z.number().int();
const filtersJson = z.record(z.string(), z.unknown()).nullable().optional();

export const updateTemplateInput = {
  params: idParams,
  query: companyQuery,
  body: z.strictObject({ name: z.string().optional(), companyId }),
} satisfies RequestSchemas;

export const createMetricInput = {
  query: companyQuery,
  body: z.strictObject({
    templateId: z.number().int(),
    name: z.string().regex(/\S/),
    beforeSourceType: z.string().nullable().optional(),
    sourceType: z.string().nullable().optional(),
    sourceField: z.string().nullable().optional(),
    operation: z.string().nullable().optional(),
    filtersJson,
    sortOrder: sortOrder.nullable().optional(),
    companyId,
  }),
} satisfies RequestSchemas;

export const updateMetricInput = {
  params: idParams,
  query: companyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    beforeSourceType: z.string().optional(),
    sourceType: z.string().optional(),
    sourceField: z.string().optional(),
    operation: z.string().optional(),
    filtersJson,
    sortOrder: sortOrder.optional(),
    companyId,
  }),
} satisfies RequestSchemas;

export const deleteMetricInput = {
  params: idParams,
  query: companyQuery,
  body: companyOnlyBody,
} satisfies RequestSchemas;

export const refreshRunInput = {
  params: idParams,
  query: companyQuery,
  body: companyOnlyBody,
} satisfies RequestSchemas;

export const saveRunValuesInput = {
  params: z.strictObject({ runId: positiveIntParam }),
  query: companyQuery,
  body: z.strictObject({
    // beforeValue and manualAdjustment feed arithmetic directly, so they must be numbers.
    entries: z.array(
      z.strictObject({
        metricId: z.number().int(),
        beforeValue: z.number().nullable().optional(),
        manualAdjustment: z.number().nullable().optional(),
      })
    ),
    companyId,
  }),
} satisfies RequestSchemas;
