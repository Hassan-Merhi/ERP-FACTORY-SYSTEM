export interface Phase8SourceVoucherEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  payload: {
    voucher: Record<string, unknown>;
    entries: Array<Record<string, unknown>>;
  };
}
export interface Phase8JournalShape {
  voucher: Record<string, unknown>;
  date: string;
  entries: Array<{
    ledgerAccountId: number;
    debitAmount: string;
    creditAmount: string;
    narration: string | null;
  }>;
  ledgerAccountIds: number[];
}
export function approvedPhase8JournalShape(event: Phase8SourceVoucherEvent): Phase8JournalShape;
