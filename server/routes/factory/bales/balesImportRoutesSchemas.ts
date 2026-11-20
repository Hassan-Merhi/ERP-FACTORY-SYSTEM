/**
 * Request schemas for the factory import routes registered by
 * ./balesImportRoutes.ts, ./registerBalesImportRoutesPart1.ts and
 * ./registerBalesImportRoutesPart2.ts. The row shapes are the ones the Factory
 * Import screens build (client/src/pages/factory/factoryimport/types.ts), all
 * strings; numeric cells are also accepted as numbers because the handlers
 * convert them (parseMoneyInput, toMoney, String) and the tests send both.
 * Missing or empty cells stay optional: the handlers report them per row.
 */
import { z } from "zod";
import { emptyQuery, identityOnlyBody, type RequestSchemas } from "../../../lib/validateRequest";

const text = z.string().nullable().optional();
const amount = z.union([z.number(), z.string()]).nullable().optional();

/** POST /api/factory/raw-stock/recalc-opening: an action with no input but the retry identity. */
export const recalcOpeningInput = { query: emptyQuery, body: identityOnlyBody } satisfies RequestSchemas;

/** POST /api/factory/import/opening-raw-stock (OpeningStockRow). */
export const openingRawStockImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    items: z
      .array(
        z.strictObject({
          supplier: text,
          kg: amount,
          costPerKg: amount,
          currency: text,
          fxRateToUsd: amount,
          openingDate: text,
          notes: text,
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/import/suppliers (SupplierRow). */
export const supplierImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    suppliers: z
      .array(
        z.strictObject({
          name: text,
          openingBalance: amount,
          contactPerson: text,
          phone: text,
          email: text,
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/import/raw-stock (RawStockRow). */
export const rawStockImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    items: z
      .array(
        z.strictObject({
          containerNumber: text,
          supplierName: text,
          receivedKg: amount,
          usedKg: amount,
          costPerKg: amount,
          arrivalDate: text,
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

/** POST /api/factory/import/bales (BaleRow plus the uploaded file name). */
export const baleImportInput = {
  query: emptyQuery,
  body: z.strictObject({
    bales: z
      .array(
        z.strictObject({
          baleCode: text,
          articleCode: text,
          productName: text,
          category: text,
          grade: text,
          weightKg: amount,
          costPerKg: amount,
          status: text,
        })
      )
      .optional(),
    fileName: text,
  }),
} satisfies RequestSchemas;
