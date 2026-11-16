import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest, type BuiltGenericVoucherPosting } from "./genericVoucherPosting";
import {
  GoldenCoastPhase1InputError,
  buildGoldenCoastPhase1PostingRequest,
  buildGoldenCoastPhase1Preview,
  type GoldenCoastPhase1EventType,
} from "./goldenCoastPosting";

export interface GoldenCoastPhase1PostingBatchInput {
  companyId: number;
  clientRequestId: unknown;
  voucherNumber: unknown;
  voucherDate: unknown;
  event: unknown;
  exchangeRate: string | null;
  actor?: PostingActor;
}

export interface GoldenCoastPhase1PostingItem {
  role: "primary" | "cogs";
  request: CentralPostingRequest;
}

export interface GoldenCoastPhase1PostingBatch {
  eventType: GoldenCoastPhase1EventType;
  clientRequestId: string;
  postings: GoldenCoastPhase1PostingItem[];
}

function retagPosting(
  built: BuiltGenericVoucherPosting,
  eventType: GoldenCoastPhase1EventType,
  rootClientRequestId: string,
  role: "primary" | "cogs"
): CentralPostingRequest {
  return {
    ...built.request,
    source: {
      sourceType: "golden-coast-phase1",
      sourceId: `${eventType}:${rootClientRequestId}:${role}`,
      idempotencyKey: `golden-coast-phase1:${rootClientRequestId}:${role}`,
    },
  };
}

export function buildGoldenCoastPhase1PostingBatch(
  input: GoldenCoastPhase1PostingBatchInput
): GoldenCoastPhase1PostingBatch {
  const preview = buildGoldenCoastPhase1Preview(input.event);

  if (preview.eventType !== "location_sale") {
    const built = buildGoldenCoastPhase1PostingRequest(input);
    return {
      eventType: built.eventType,
      clientRequestId: built.clientRequestId,
      postings: [{ role: "primary", request: built.request }],
    };
  }

  if (preview.kind !== "voucher") {
    throw new GoldenCoastPhase1InputError("Location sale preview must produce a voucher");
  }

  const revenueEntries = preview.voucher.entries.slice(0, 2).map((entry) => ({ ...entry }));
  const cogsEntries = preview.voucher.entries.slice(2).map((entry) => ({ ...entry }));

  const primary = buildGenericVoucherPostingRequest({
    companyId: input.companyId,
    clientRequestId: input.clientRequestId,
    voucher: {
      locationId: preview.voucher.locationId,
      voucherNumber: input.voucherNumber,
      voucherType: "Sales",
      voucherDate: input.voucherDate,
      description: preview.voucher.description,
      currency: "USD",
    },
    entries: revenueEntries,
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  const postings: GoldenCoastPhase1PostingItem[] = [
    {
      role: "primary",
      request: retagPosting(primary, preview.eventType, primary.clientRequestId, "primary"),
    },
  ];

  if (cogsEntries.length > 0) {
    const cogs = buildGenericVoucherPostingRequest({
      companyId: input.companyId,
      clientRequestId: primary.clientRequestId,
      voucher: {
        locationId: preview.voucher.locationId,
        voucherNumber: `${primary.request.voucher.voucherNumber}-COGS`,
        voucherType: "Journal",
        voucherDate: primary.request.voucher.voucherDate,
        description: preview.voucher.description ? `${preview.voucher.description} - COGS` : "COGS",
        currency: "USD",
      },
      entries: cogsEntries,
      exchangeRate: input.exchangeRate,
      actor: input.actor,
    });
    postings.push({
      role: "cogs",
      request: retagPosting(cogs, preview.eventType, primary.clientRequestId, "cogs"),
    });
  }

  return {
    eventType: preview.eventType,
    clientRequestId: primary.clientRequestId,
    postings,
  };
}
