/**
 * Request schemas for the cost-center write routes. Both prefixes
 * (/api/cost-centers and /api/factory/cost-centers) share these.
 * Body shapes reuse the schemas the handlers already parse with; path ids are
 * kept as strings because the handlers parse and reject them with their own
 * messages.
 */
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../lib/validateRequest";
import { autoRuleSetBody, centerBody, editBody, replaceBody } from "./costCenterRoutesSourceInCompany";
import { previewBody } from "./costCenterHistoricalRoutesSourceSql";

const idParams = z.strictObject({ id: stringParam });

export const createCenterInput = { query: emptyQuery, body: centerBody } satisfies RequestSchemas;

export const updateCenterInput = { params: idParams, query: emptyQuery, body: editBody } satisfies RequestSchemas;

export const archiveCenterInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export const autoRulesInput = { query: emptyQuery, body: autoRuleSetBody } satisfies RequestSchemas;

export const replaceAllocationsInput = {
  params: z.strictObject({ sourceType: stringParam, sourceId: stringParam }),
  query: emptyQuery,
  body: replaceBody,
} satisfies RequestSchemas;

export const historicalPreviewInput = { query: emptyQuery, body: previewBody } satisfies RequestSchemas;

// The handler checks the APPLY confirmation itself.
export const historicalApplyInput = {
  params: z.strictObject({ batchId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({ confirmation: z.string().optional() }),
} satisfies RequestSchemas;
