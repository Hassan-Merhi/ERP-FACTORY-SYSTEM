// Request schemas for the factory POS sale write routes (create, edit, void).
import { z } from "zod";
import { emptyQuery, stringParam, type RequestSchemas } from "../../../../lib/validateRequest";

// Ids and amounts arrive as numbers from the POS page and as numeric strings
// from older forms and tests; the handlers parseInt / parseMoneyInput them.
const idLike = z.union([z.number(), z.string()]);
const amountLike = z.union([z.number(), z.string()]);

const saleItem = z.strictObject({
  productId: idLike.nullable().optional(),
  productName: z.string().nullable().optional(),
  articleCode: z.string().nullable().optional(),
  quantity: amountLike.nullable().optional(),
  unitPrice: amountLike.nullable().optional(),
});

const saleExpense = z.strictObject({
  accountId: idLike.nullable().optional(),
  description: z.string().nullable().optional(),
  amount: amountLike.nullable().optional(),
});

// The handlers keep their own "At least one item is required" / "Each item
// needs a product" / "Quantity must be positive" / "Invalid amount" checks.
const saleFields = {
  locationId: idLike.nullable().optional(),
  customerName: z.string().nullable().optional(),
  customerId: idLike.nullable().optional(),
  notes: z.string().nullable().optional(),
  txDate: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  cashAccountId: idLike.nullable().optional(),
  paymentType: z.string().nullable().optional(),
  depositAmount: amountLike.nullable().optional(),
  items: z.array(saleItem).optional(),
  expenses: z.array(saleExpense).nullable().optional(),
};

const saleParams = z.strictObject({ id: stringParam });

export const createFactoryPosSaleInput = {
  query: emptyQuery,
  // clientRequestId: the request identity attachAccountingRequestIdentity adds;
  // resolveFinancialOperationKey reads it for idempotent replay.
  body: z.strictObject({ ...saleFields, clientRequestId: z.string().optional() }),
} satisfies RequestSchemas;

// Edit and void read no request identity; a clientRequestId is accepted and
// ignored (the factory route test harnesses attach one to every call).
const ignoredClientRequestId = z.string().optional();

export const updateFactoryPosSaleInput = {
  params: saleParams,
  query: emptyQuery,
  body: z.strictObject({ ...saleFields, clientRequestId: ignoredClientRequestId }),
} satisfies RequestSchemas;

export const voidFactoryPosSaleInput = {
  params: saleParams,
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ clientRequestId: ignoredClientRequestId })]),
} satisfies RequestSchemas;
