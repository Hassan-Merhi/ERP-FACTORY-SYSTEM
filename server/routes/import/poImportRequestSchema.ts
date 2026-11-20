/**
 * Request schema for POST /api/po-import/validate and /api/po-import/import.
 *
 * The wizard posts back the `preview` the parse endpoint returned
 * (poImportExcelParser.ts ParsedContainerPreview), with resolved stock item
 * names merged in. Its cells come from a spreadsheet, so scalar values stay
 * loose here: findPreviewContainer and the import step read them leniently and
 * report unreadable money themselves. Required-field checks stay in the
 * handlers, with their messages.
 */
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../../lib/validateRequest";

/** A spreadsheet cell as the preview carries it. */
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();

/** One ParsedItemRow, plus the native Kwacha fields the server type also names. */
const previewItem = z.strictObject({
  rowNum: cell,
  poNumber: cell,
  containerNumber: cell,
  supplierCode: cell,
  barcode: cell,
  stockItemId: cell,
  itemName: cell,
  quantity: cell,
  rate: cell,
  lineTotal: cell,
  currency: cell,
  nativeRate: cell,
  nativeLineTotal: cell,
  freight: cell,
  surcharge: cell,
  fumigation: cell,
  discount: cell,
  documentCharges: cell,
});

const previewCharges = z.strictObject({
  freight: cell,
  surcharge: cell,
  fumigation: cell,
  discount: cell,
  documentCharges: cell,
  otherCharges: cell,
});

/** One ParsedContainerPreview. */
const previewContainer = z.strictObject({
  containerNumber: cell,
  supplierCode: cell,
  itemsCount: cell,
  posCount: cell,
  itemsTotal: cell,
  charges: previewCharges.nullable().optional(),
  chargesTotal: cell,
  grandTotal: cell,
  items: z.array(previewItem).nullable().optional(),
  pos: z.array(cell).nullable().optional(),
});

/** client/src/pages/useErpPOImportStatePart2.ts buildPayload(). */
export const poImportRequestInput = {
  query: emptyQuery,
  body: z.strictObject({
    fileHash: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    containerNumber: z.string().nullable().optional(),
    supplierId: z.union([z.number(), z.string()]).nullable().optional(),
    importDate: z.string().nullable().optional(),
    exchangeRate: z.union([z.string(), z.number()]).nullable().optional(),
    currency: z.string().nullable().optional(),
    preview: z.array(previewContainer).nullable().optional(),
    freightPaidBy: z.string().nullable().optional(),
    freightParentAccountId: z.union([z.number(), z.string()]).nullable().optional(),
  }),
} satisfies RequestSchemas;
