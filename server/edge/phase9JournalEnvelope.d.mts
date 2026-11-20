export declare const PHASE9_JOURNAL_KIND: "voucher.journal.v1";

export interface Phase9JournalEntry {
  type: "DR" | "CR";
  accountType: "ledger" | "customer" | "bank" | "supplier" | "factorySupplier" | "employee" | "fixedAsset";
  accountId: number;
  amount: string;
  narration: string | null;
}

export interface Phase9JournalInputs {
  voucherDate: string;
  entries: Phase9JournalEntry[];
  notes: string | null;
  optional: boolean;
  currency: string;
  exchangeRate: string | null;
  effectiveDate: string | null;
}

export interface Phase9JournalEvidence {
  requestId: string;
  companyId: number;
  actorUserId: string;
  actorUsername: string;
  localVoucherId: number;
  journal: Phase9JournalInputs;
}

export interface Phase9JournalPayload extends Phase9JournalEvidence {
  kind: typeof PHASE9_JOURNAL_KIND;
}

export declare class Phase9JournalRefusal extends Error {
  constructor(code: string);
}

export declare function phase9JournalEnvelope(evidence: Phase9JournalEvidence): Phase9JournalPayload;
