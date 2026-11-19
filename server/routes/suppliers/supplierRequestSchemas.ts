/** Request schemas for the supplier write routes in ../supplierRoutes.ts. */
import { z } from "zod";
import { insertCompanyScopedSupplierSchema } from "@shared/schema/supplierCompanyScope";

import { emptyBody, stringParam, type RequestSchemas } from "../../lib/validateRequest";

// parseSupplierId (parseInt) keeps its own id check, so the id stays a string here.
const supplierParams = z.strictObject({ id: stringParam });
// The service replaces any companyId with the session company before it parses the body.
const supplierCompanyIdField = {
  companyId: z.unknown().optional(), // sent by client/src/pages/accountingcreate/components/EntityFormWrapper.tsx; not used
};

export const createSupplierInput = {
  body: insertCompanyScopedSupplierSchema.omit({ companyId: true }).extend(supplierCompanyIdField).strict(),
} satisfies RequestSchemas;

export const updateSupplierInput = {
  params: supplierParams,
  body: insertCompanyScopedSupplierSchema.omit({ companyId: true }).partial().extend(supplierCompanyIdField).strict(),
} satisfies RequestSchemas;

export const deleteSupplierInput = { params: supplierParams, body: emptyBody } satisfies RequestSchemas;

export const assignStockGroupInput = {
  params: supplierParams,
  // parseSupplierStockGroupId: null or absent clears the group; anything else must be Number()-able.
  body: z.strictObject({ stockGroupId: z.union([z.number(), z.string()]).nullable().optional() }),
} satisfies RequestSchemas;
