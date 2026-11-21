export declare const PHASE9_PC_RECORD_ID_BASE: 1_000_000_000;
export declare const PHASE9_CUSTOMER_CREATE_KIND: "customer.create.v1";
export declare const PHASE9_CUSTOMER_DUPLICATE_CONFLICT: "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE";

export interface Phase9CustomerCreateFields {
  legalName: string;
  phone: string | null;
  openingBalance: string;
  openingBalanceSide: "Dr" | "Cr";
  active: boolean;
  statementNote: string | null;
  paymentTermsDays: number | null;
  ledgerAccountId: number | null;
}

export interface Phase9CustomerCreateEvidence {
  requestId: string;
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  businessDate: string;
  localCustomerId: number;
  localLedgerAccountId: number | null;
  customer: Phase9CustomerCreateFields;
}

export interface Phase9CustomerCreatePayload extends Phase9CustomerCreateEvidence {
  kind: typeof PHASE9_CUSTOMER_CREATE_KIND;
}

export declare class Phase9CustomerCreateRefusal extends Error {
  constructor(code: string);
}

export declare function phase9CustomerCreateEnvelope(
  evidence: Phase9CustomerCreateEvidence
): Phase9CustomerCreatePayload;
