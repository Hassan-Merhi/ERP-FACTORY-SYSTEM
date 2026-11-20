// Extracted from ./phase9StockOutbox.ts
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import {
  phase9StockItemCreateEnvelope,
  type Phase9StockItemCreateEvidence,
} from "./phase9StockItemLifecycleEnvelope.mjs";
import { appendStockEventTx } from "./phase9StockOutboxHelpers.ts";

/** Plan batch 2: a stock item created on the LAN primary; no-op elsewhere. */
export async function capturePhase9StockItemCreateTx(
  tx: DbTransaction,
  evidence: Phase9StockItemCreateEvidence
): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  const event = phase9StockItemCreateEnvelope(evidence);
  await appendStockEventTx(tx, String(config.siteId), event, event.localStockItemId);
}

export function lanSiteId(): string | null {
  const config = readFactoryEdgeConfiguration();
  return config.mode === "lan" && config.primary && config.siteId ? String(config.siteId) : null;
}

/** Was this row created on this LAN server during the outage (recorded on the stock stream)? */
export async function recordedOnLanTx(
  tx: DbTransaction,
  siteId: string,
  kind: string,
  localRef: number
): Promise<boolean> {
  const found = await tx.execute(sql`
    SELECT 1 FROM factory_edge_stock_outbox
     WHERE site_id = ${siteId}::uuid AND operation_kind = ${kind} AND local_movement_id = ${localRef}
     LIMIT 1
  `);
  return found.rows.length > 0;
}
