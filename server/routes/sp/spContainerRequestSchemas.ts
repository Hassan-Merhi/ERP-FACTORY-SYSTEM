/**
 * Request schemas for the Supplier Partner container write routes
 * (registerSpContainerRoutesPart1.ts, registerSpContainerRoutesPart3.ts).
 */
import { z } from "zod";
import { idParams, type RequestSchemas } from "../../lib/validateRequest";
import { amountish, numberish, spWriteFields } from "./spRequestSchemas";

export const optionalAmount = amountish.nullable().optional();

export const spContainerLineSchema = z.strictObject({
  articleCode: z.union([z.string(), z.number()]).nullable().optional(),
  description: z.string().nullable().optional(),
  qty: optionalAmount,
  unitRateUsd: optionalAmount,
  stockItemId: numberish.nullable().optional(),
});

export const spContainerHeaderFields = {
  ...spWriteFields,
  supplierId: numberish.nullable().optional(),
  supplierName: z.string().nullable().optional(),
  containerNumber: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(),
  invoiceDate: z.string().nullable().optional(),
  invoiceTotalUsd: optionalAmount,
  discountPct: optionalAmount,
  freightEstimateUsd: optionalAmount,
  surchargeUsd: optionalAmount,
  fumigationUsd: optionalAmount,
  documentChargesUsd: optionalAmount,
  notes: z.string().nullable().optional(),
};

/** POST /api/sp/containers and POST /api/sp/containers/import-excel/validate. */
const spContainerCreateBody = z.strictObject({
  ...spContainerHeaderFields,
  importSource: z.string().nullable().optional(),
  lines: z.array(spContainerLineSchema).nullable().optional(),
  otwAccountId: numberish.nullable().optional(),
  otwClearingAccountId: numberish.nullable().optional(),
});

export const createSpContainerInput = { body: spContainerCreateBody } satisfies RequestSchemas;

export const validateSpContainerImportInput = { body: spContainerCreateBody } satisfies RequestSchemas;

export const updateSpContainerInput = {
  params: idParams,
  body: z.strictObject(spContainerHeaderFields),
} satisfies RequestSchemas;

/**
 * POST /api/sp/containers/import-excel/parse: multipart, the workbook is
 * req.file. The clients send only the file, so multer leaves no text fields;
 * SP guard/write fields would arrive as form strings.
 */
export const parseSpContainerExcelInput = {
  body: z.union([z.undefined(), z.strictObject(spWriteFields)]),
} satisfies RequestSchemas;
