export declare const PHASE9_PC_RECORD_TYPES: Readonly<{ customer: "customer"; ledger: "ledger_account" }>;
export type Phase9PcRecordType = "customer" | "ledger_account";

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export declare class Phase9PcRecordNotYetSynced extends Error {
  missing: string[];
  constructor(missing: string[]);
}

export declare function translatePhase9PcRecords<T extends { payload: unknown }>(
  queryable: Queryable,
  siteId: string,
  event: T
): Promise<T>;

export declare function readPhase9PcRecordMapping(
  queryable: Queryable,
  siteId: string,
  recordType: Phase9PcRecordType,
  localId: number
): Promise<number | null>;

export declare function recordPhase9PcRecordMapping(
  queryable: Queryable,
  input: {
    siteId: string;
    recordType: Phase9PcRecordType;
    localId: number;
    cloudId: number;
    companyId: number;
    operationId: string;
  }
): Promise<void>;
