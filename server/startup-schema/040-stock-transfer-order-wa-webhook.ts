/** Stage 040: exactly one accepted inbound decision per approval batch. */
export const stockTransferOrderWaWebhookIntegrity: string[] = [
  "CREATE UNIQUE INDEX IF NOT EXISTS sto_wa_batch_decision_once_uk ON stock_transfer_order_approval_events (company_id,batch_id) WHERE event_type IN ('done_received','decline_received')",
];
