/**
 * validateRequest schemas for the AI import write routes. Ids stay strings:
 * the handlers parse them with parseInt and answer their own 400.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../lib/validateRequest";

const jobIdParams = z.strictObject({ id: stringParam });

/** POST /api/ai-import/upload (multipart: form fields arrive as strings). */
export const uploadInput = {
  query: emptyQuery,
  body: z.strictObject({ importType: z.string().optional() }),
} satisfies RequestSchemas;

/** POST /api/ai-import/jobs/:id/validate | confirm | post */
export const jobActionInput = {
  params: jobIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

const correctionSchema = z.strictObject({
  // Entries without memoryType or rawValue are skipped by the handler.
  memoryType: z.string().optional(),
  rawValue: z.union([z.string(), z.number()]).nullable().optional(),
  resolvedId: z.number().int().nullable().optional(),
  resolvedValue: z.string().nullable().optional(),
  resolvedType: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
});

/** PATCH /api/ai-import/rows/:rowId */
export const updateRowInput = {
  params: z.strictObject({ rowId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    corrections: z.array(correctionSchema).optional(),
    // Merged on top of the re-validated mapped data.
    mappedData: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
} satisfies RequestSchemas;

/** DELETE /api/ai-import/corrections/:id */
export const deleteCorrectionInput = {
  params: jobIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
