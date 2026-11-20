import { z } from "zod";
import { insertLocationSchema } from "@shared/schema";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../lib/validateRequest";

// The location handlers parse :locationId themselves (parseInt) and keep their
// own "Invalid location ID" answers, so the params stay strings here.
const locationParams = z.strictObject({ locationId: stringParam });

// Flags the handlers read with parseBoolean / parseIncludeCost (true, 1, "1", "true").
const looseFlag = z.union([z.boolean(), z.number(), z.string()]).nullable().optional();
const looseId = z.union([z.number(), z.string()]).nullable().optional();

// The server sets companyId from the session and generates a missing code.
export const createLocationInput = {
  query: emptyQuery,
  body: insertLocationSchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

export const patchLocationInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().optional(),
    transferWaGroupChatId: z.string().nullable().optional(),
    supplierPartnerPayableDeductionPerQty: z.union([z.number(), z.string()]).optional(),
    // Declared so the handler can still answer with its own "use the WhatsApp
    // settings endpoint" message; requests carrying whatsappGroupChatId are
    // served by the legacy compatibility route registered first.
    whatsappGroupName: z.unknown().optional(),
    whatsappStockReportsEnabled: z.unknown().optional(),
  }),
} satisfies RequestSchemas;

// Older POS settings clients (client/src/pages/settings/usePosWhatsAppSectionState.tsx)
// send { name, whatsappGroupChatId }.
export const legacyLocationWhatsappInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({
    name: z.string().nullable().optional(),
    whatsappGroupChatId: z.string().nullable(),
  }),
} satisfies RequestSchemas;

export const deleteLocationInput = {
  params: locationParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const locationWhatsappSettingsInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({
    whatsappGroupChatId: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  }),
} satisfies RequestSchemas;

export const locationWhatsappTestInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({ whatsappGroupChatId: z.string().nullable().optional() }),
} satisfies RequestSchemas;

export const sendLocationStockWhatsappInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({
    includeCost: looseFlag,
    idempotencyKey: z.string().optional(),
    // null or "none" selects unassigned items; otherwise a stock group id.
    stockGroupId: looseId,
  }),
} satisfies RequestSchemas;

export const retryLocationStockDeliveryInput = {
  params: z.strictObject({ locationId: stringParam, deliveryId: stringParam }),
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ idempotencyKey: z.string().optional() })]),
} satisfies RequestSchemas;

export const locationWhatsappScheduleInput = {
  params: locationParams,
  query: emptyQuery,
  body: z.strictObject({
    enabled: looseFlag,
    frequency: z.string().optional(),
    daysOfWeek: z
      .array(z.union([z.number(), z.string()]))
      .nullable()
      .optional(),
    sendTime: z.string().optional(),
    timezone: z.string().optional(),
    includeCost: looseFlag,
    includeZeroStock: looseFlag,
    includeNegativeStock: looseFlag,
    stockGroupId: looseId,
    categoryId: looseId,
  }),
} satisfies RequestSchemas;
