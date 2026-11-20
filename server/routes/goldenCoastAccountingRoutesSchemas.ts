// Request schemas for the Golden Coast Phase 1 accounting write routes.
// The event shapes mirror buildGoldenCoastPhase1Preview
// (server/services/accounting/goldenCoastPhase1Posting.ts), which keeps its
// own per-field checks and messages.
import { z } from "zod";
import { emptyQuery, type RequestSchemas } from "../lib/validateRequest";

const money = z.union([z.number(), z.string()]);
const id = z.union([z.number(), z.string()]);
const text = z.string().nullable().optional();
const account = z.strictObject({ kind: z.string(), id, name: z.string().nullable().optional() });

const phase1Event = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("partner_cash_contribution"),
    amountUsd: money,
    cashAccount: account,
    partnerCapitalAccount: account,
    partnerName: z.string(),
  }),
  z.strictObject({
    type: z.literal("inventory_in_transit_contribution"),
    goodsCostUsd: money,
    stockOtwAccount: account,
    partnerCapitalAccount: account,
    partnerName: z.string(),
    containerReference: text,
  }),
  z.strictObject({
    type: z.literal("container_reserve_plan"),
    reserveUsd: money,
    expectedDutyUsd: money,
    expectedTransportUsd: money,
  }),
  z.strictObject({
    type: z.literal("funding_allocation_plan"),
    fundingBalanceUsd: money,
    inventoryInTransitUsd: money,
    containerReserveUsd: money,
  }),
  z.strictObject({
    type: z.literal("container_cost_payment"),
    amountUsd: money,
    stockOtwAccount: account,
    paymentAccount: account,
    chargeLabel: z.string(),
    containerReference: text,
  }),
  z.strictObject({
    type: z.literal("container_offload"),
    totalLandedCostUsd: money,
    inventoryAccount: account,
    stockOtwAccount: account,
    locationId: id,
    containerReference: text,
  }),
  z.strictObject({
    type: z.literal("savings_transfer"),
    amountUsd: money,
    operatingCashAccount: account,
    savingsAccount: account,
  }),
  z.strictObject({
    type: z.literal("owner_withdrawal"),
    amountUsd: money,
    ownerDrawingsAccount: account,
    paymentAccount: account,
    ownerName: z.string(),
  }),
  z.strictObject({
    type: z.literal("sale_economics"),
    quantity: money,
    salePricePerUnitUsd: money,
    inventoryCostPerUnitUsd: money,
  }),
  z.strictObject({
    type: z.literal("location_sale"),
    quantity: money,
    salePricePerUnitUsd: money,
    inventoryCostPerUnitUsd: money,
    locationId: id,
    cashOrReceivableAccount: account,
    salesRevenueAccount: account,
    cogsAccount: account,
    inventoryAccount: account,
    description: text,
  }),
]);

export const phase1SetupAccountsInput = {
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({
      accounts: z
        .array(z.strictObject({ subType: z.string(), code: text, name: text }))
        .nullable()
        .optional(),
    }),
  ]),
} satisfies RequestSchemas;

export const phase1PreviewInput = {
  query: emptyQuery,
  body: z.strictObject({ event: phase1Event }),
} satisfies RequestSchemas;

export const phase1PostInput = {
  query: emptyQuery,
  body: z.strictObject({
    // The posting batch derives its idempotency key from clientRequestId.
    clientRequestId: z.string(),
    voucherNumber: z.string(),
    voucherDate: z.string(),
    event: phase1Event,
  }),
} satisfies RequestSchemas;
