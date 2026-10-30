import type { Pool } from "pg";
export interface Phase7WriterConfig {
  mode: "cloud" | "lan";
  primary: boolean;
  siteId?: string | null;
  writerEpoch?: string | null;
  baselineSha256?: string | null;
}
export interface Phase7WriterProof {
  site_id: string;
  mode: string;
  epoch: string | number | bigint;
  baseline_sha256: string;
  role_safe: boolean;
  uncovered_tables: number;
}
export const PHASE7_AUTHORITY_SQL: string;
export function isVerifiedPhase7WriterRow(row: Partial<Phase7WriterProof> | null, config: Phase7WriterConfig): boolean;
export function hasVerifiedPhase7WriterAuthority(
  queryable: Pick<Pool, "query">,
  config: Phase7WriterConfig
): Promise<boolean>;
