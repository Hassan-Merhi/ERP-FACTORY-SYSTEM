import { z } from "zod";
import { emptyBody, emptyQuery, idParams, type RequestSchemas } from "../../lib/validateRequest";

// Columns and rows are a spreadsheet grid the Status Builder page
// (client/src/pages/factory/factorystatusbuilder/types.ts) loads from jsonb and
// saves back verbatim. Sheets saved by earlier versions may carry keys the
// current types do not list, so the grid is checked as arrays of plain values
// or key/value maps rather than strict objects; rejecting an old key would stop
// that sheet from autosaving. The request body itself stays strict.
const gridEntry = z.union([z.string(), z.number(), z.null(), z.record(z.string(), z.unknown())]);
const sheetColumn = gridEntry;
const sheetRow = z.record(z.string(), z.unknown());

export const createSheetInput = {
  query: emptyQuery,
  // The handler answers "Sheet name is required" for a missing or blank name.
  body: z.strictObject({ name: z.string().nullable().optional() }),
} satisfies RequestSchemas;

export const updateSheetInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    columns: z.array(sheetColumn).optional(),
    rows: z.array(sheetRow).optional(),
  }),
} satisfies RequestSchemas;

export const deleteSheetInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// Multipart: the workbook is the file; there are no form fields.
export const importSheetsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
