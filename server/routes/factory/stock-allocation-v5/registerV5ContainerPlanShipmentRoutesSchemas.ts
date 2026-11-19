// Request schemas for the V5 container plan shipment and document write routes
// (registerV5ContainerPlanShipmentRoutes.ts and registerV5ContainerPlanShipmentRoutesPart1.ts).
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, type RequestSchemas } from "../../../lib/validateRequest";

const containerParams = z.strictObject({ planId: stringParam, containerId: stringParam });
const optionalText = z.string().nullable().optional();

// normalizeShipmentReference/normalizeShipmentDate turn blanks into null; the
// handlers keep their own date-format, status and document-type checks.
export const updateShipmentInput = {
  params: containerParams,
  query: emptyQuery,
  body: z.strictObject({
    containerNumber: optionalText,
    carrier: optionalText,
    bookingNumber: optionalText,
    vesselName: optionalText,
    destination: optionalText,
    etd: optionalText,
    eta: optionalText,
  }),
} satisfies RequestSchemas;

export const shipmentStatusInput = {
  params: containerParams,
  query: emptyQuery,
  body: z.strictObject({ toStatus: z.string().optional(), note: optionalText }),
} satisfies RequestSchemas;

export const createDocumentInput = {
  params: containerParams,
  query: emptyQuery,
  body: z.strictObject({
    documentType: z.string().optional(),
    title: optionalText,
    reference: optionalText,
    fileUrl: optionalText,
    issuedOn: optionalText,
  }),
} satisfies RequestSchemas;

export const deleteDocumentInput = {
  params: z.strictObject({ planId: stringParam, containerId: stringParam, documentId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;
