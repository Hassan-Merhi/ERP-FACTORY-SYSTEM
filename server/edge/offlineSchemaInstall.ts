/**
 * Reviewed DBA installer for the offline-mode evidence schema. Never runs at
 * startup. Each target installs in ONE transaction, so a failure leaves no
 * partial evidence schema. Run with a privileged migration/DBA login — never
 * the restricted runtime role — and re-run the Phase 7 fence install after it
 * on any database where that fence is already installed.
 *
 *   FACTORY_OFFLINE_SCHEMA_INSTALL_ACK=DBA_REVIEWED_MAINTENANCE_WINDOW \
 *     node --import tsx server/edge/offlineSchemaInstall.ts cloud|lan
 */
import { pool } from "../db";
import { ensureCloudEdgeStageSchema } from "./edgeCloudStaging";
import { ensureEdgeVoucherOutboxSchema } from "./edgeVoucherOutbox";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { ensurePhase8ApplySchema } from "./applyStore.mjs";
import { ensurePhase9CloudEventSchema } from "./cloudEventStore.mjs";
import { ensurePhase9PressingOutboxSchema } from "./pressingOutbox";
import { ensurePhase9StockOutboxSchema } from "./stockOutbox";
import { ensurePhase9PosOutboxSchema } from "./posOutbox";
import { ensurePhase9ReceivingOutboxSchema } from "./receivingOutbox";
import { ensurePhase9AttachmentOutboxSchema } from "./attachmentOutbox";
import { ensurePhase9PaymentOutboxSchema } from "./paymentOutbox";
import { ensurePhase10SyncControlSchema } from "./syncControl.mjs";
import { ensurePhase10ConflictDecisionFunction, ensurePhase10SyncControlFunction } from "./operatorControls.mjs";
import { EdgeRefusal } from "./edgeRefusal";
import { ensurePhase9StockItemMapSchema } from "./stockItemMap.mjs";

export const OFFLINE_SCHEMA_INSTALL_ACK = "DBA_REVIEWED_MAINTENANCE_WINDOW";

export async function installOfflineSchema(target: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.FACTORY_OFFLINE_SCHEMA_INSTALL_ACK !== OFFLINE_SCHEMA_INSTALL_ACK) {
    throw new EdgeRefusal("OFFLINE_SCHEMA_INSTALL_NOT_ACKNOWLEDGED");
  }
  const edge = readFactoryEdgeConfiguration(env);
  if ((target === "lan") !== (edge.mode === "lan") || !["cloud", "lan"].includes(target)) {
    throw new EdgeRefusal("OFFLINE_SCHEMA_TARGET_MISMATCH");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (target === "cloud") {
      await ensureCloudEdgeStageSchema(client, true);
      await ensurePhase8ApplySchema(client);
      await ensurePhase9CloudEventSchema(client);
      // Phase 10: the operator panel's conflict decisions (DBA-owned function).
      await ensurePhase10ConflictDecisionFunction(client);
      // Plan batch 2: LAN-created item -> cloud item map.
      await ensurePhase9StockItemMapSchema(client);
    } else {
      await ensureEdgeVoucherOutboxSchema(client);
      await ensurePhase9PressingOutboxSchema(client);
      await ensurePhase9StockOutboxSchema(client);
      await ensurePhase9PosOutboxSchema(client);
      await ensurePhase9ReceivingOutboxSchema(client);
      await ensurePhase9AttachmentOutboxSchema(client);
      await ensurePhase9PaymentOutboxSchema(client);
      await ensurePhase10SyncControlSchema(client);
      // Phase 10: the operator panel's pause / resume (DBA-owned function).
      await ensurePhase10SyncControlFunction(client);
    }
    await client.query("COMMIT");
    return { target, installed: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && /offlineSchemaInstall\.(?:ts|js)$/.test(process.argv[1])) {
  installOfflineSchema(process.argv[2] ?? "")
    .then((result) => console.log(JSON.stringify({ offlineSchema: result })))
    .catch((error: unknown) => {
      console.error("OFFLINE_SCHEMA_INSTALL_REFUSED", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
