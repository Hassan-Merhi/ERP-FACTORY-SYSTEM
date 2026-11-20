/**
 * Request-schema building blocks shared by the Supplier Partner write routes.
 *
 * Every /api/sp write passes through enforceSpAccess (spAccessControl.ts),
 * which reads `confirmation`, `reason` and `idempotencyKey` from the body for
 * its sensitive-action checks and audit row. Routes that callers reach with
 * those fields spread `spGuardFields` into their body schema.
 *
 * Every non-migration /api/sp write is also a Phase 5 operational voucher
 * request (shared/voucherPathIdentityPolicy.ts): without an X-Idempotency-Key
 * header the voucher-path boundary takes its request identity from
 * `clientRequestId` in the body. `spWriteFields` adds it.
 */
import { z } from "zod";

export const spGuardFields = {
  confirmation: z.string().optional(),
  reason: z.string().optional(),
  idempotencyKey: z.string().optional(),
};

export const spWriteFields = {
  ...spGuardFields,
  clientRequestId: z.string().optional(),
};

/** An id the handler passes to Number()/parseInt(): callers send numbers or numeric strings. */
export const numberish = z.union([z.number(), z.string()]);

/** A money or quantity value the handler parses from a number or string. */
export const amountish = z.union([z.number(), z.string()]);
