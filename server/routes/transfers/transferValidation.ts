import { insertInterCompanyTransferSchema } from "@shared/schema";
import { z } from "zod";

import { TransferRouteError } from "./transferErrors";
import { parseMoneyInput } from "../../lib/money";

const clientRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .optional();

const simpleTransferSchema = z.object({
  fromCompanyId: z.number().int().positive(),
  toCompanyId: z.number().int().positive(),
  fromLedgerAccountId: z.number().int().positive(),
  toLedgerAccountId: z.number().int().positive(),
  amount: z.string(),
  transferDate: z.string(),
  description: z.string().optional(),
  clientRequestId: clientRequestIdSchema,
});

const interCompanyTransferSchema = insertInterCompanyTransferSchema.extend({
  clientRequestId: clientRequestIdSchema,
});

export function parseInterCompanyTransferInput(input: unknown) {
  return interCompanyTransferSchema.parse(input);
}

export function parseSimpleTransferInput(input: unknown) {
  const parsed = simpleTransferSchema.parse(input);
  const amount = parseMoneyInput(parsed.amount)?.toNumber() ?? NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TransferRouteError(400, "Amount must be positive");
  }
  return parsed;
}

export function parseTransferId(value: string): number {
  const transferId = Number.parseInt(value, 10);
  if (!Number.isInteger(transferId) || transferId <= 0) {
    throw new TransferRouteError(400, "Invalid transfer ID");
  }
  return transferId;
}

export function parseCompanyId(value: string): number {
  const companyId = Number.parseInt(value, 10);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new TransferRouteError(400, "Invalid company ID");
  }
  return companyId;
}
