/** Phase 6 report lookup acceleration (after stage 037). */
export const factoryPressingHistoryReportIndexes: string[] = [
  "CREATE INDEX IF NOT EXISTS factory_pressing_confirmations_machine_time_idx ON factory_pressing_confirmations (company_id, machine_id, confirmed_at DESC, id DESC) WHERE voided_at IS NULL",
];
