/**
 * validateRequest schemas for the factory shipping-container write routes
 * (rows.ts, documents.ts, scheduled.ts, availability.ts). Kept beside them
 * so those route files stay under the line cap.
 */
import { z } from "zod";
import { insertFactoryScheduledContainerSchema, insertFactoryShippingAvailabilitySchema } from "@shared/schema";
import { emptyBody, emptyQuery, type RequestSchemas } from "../../../lib/validateRequest";

/**
 * A row id the handlers used to read with parseInt and reject only when NaN.
 * Same acceptance, parsed to the number the handler used.
 */
const parseIntParam = z
  .string()
  .transform((value) => parseInt(value))
  .refine((value) => !Number.isNaN(value));

const rowIdParams = z.strictObject({ id: parseIntParam });
const nullableText = z.string().nullable().optional();

export const syncShippingRowsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// customerOrderId and orderDate stay optional so the handler keeps its own
// "required" message.
export const createShippingRowInput = {
  query: emptyQuery,
  body: z.strictObject({
    customerOrderId: z.union([z.number(), z.string()]).optional(),
    orderDate: z.string().optional(),
    containerArrivedDate: nullableText,
    note: nullableText,
    anything: nullableText,
  }),
} satisfies RequestSchemas;

export const updateShippingRowInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.strictObject({
    eta: nullableText,
    containerArrivedDate: nullableText,
    note: nullableText,
    anything: nullableText,
    ciNumber: nullableText,
    trackingLink: nullableText,
  }),
} satisfies RequestSchemas;

export const syncShippingRowOrderInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.strictObject({
    containerNumber: nullableText,
    shippingCompany: nullableText,
    destination: nullableText,
  }),
} satisfies RequestSchemas;

export const markShippingRowDoneInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ markWhatsappSent: z.boolean().nullable().optional() })]),
} satisfies RequestSchemas;

export const shippingRowNoBodyInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

// Multipart form fields (strings after multer); the file itself is req.file.
export const uploadShippingRowDocumentInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ displayName: z.string().optional() })]),
} satisfies RequestSchemas;

export const deleteShippingRowDocumentInput = {
  params: z.strictObject({ id: parseIntParam, docId: parseIntParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export const uploadShippingInvoiceInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({})]),
} satisfies RequestSchemas;

export const cleanupGhostDocsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// The handlers add companyId from the session.
export const createScheduledContainerInput = {
  query: emptyQuery,
  body: insertFactoryScheduledContainerSchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

export const createShippingAvailabilityInput = {
  query: emptyQuery,
  body: insertFactoryShippingAvailabilitySchema.omit({ companyId: true }).strict(),
} satisfies RequestSchemas;

// PATCH handlers keep their own per-field checks (blank date, negative count).
// Counts go through Number(...), so the numeric string form stays accepted.
const containerCount = z.union([z.number(), z.string()]).optional();
const editableRowFields = {
  date: z.string().optional(),
  shippingCompany: z.string().optional(),
  note: nullableText,
  details: nullableText,
  isArchived: z.boolean().optional(),
};

export const updateScheduledContainerInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.strictObject({ ...editableRowFields, scheduledContainers: containerCount }),
} satisfies RequestSchemas;

export const updateShippingAvailabilityInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: z.strictObject({ ...editableRowFields, availableContainers: containerCount }),
} satisfies RequestSchemas;

export const deleteShippingScheduleRowInput = {
  params: rowIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
