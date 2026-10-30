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
import { ensurePhase8ApplySchema } from "./phase8ApplyStore.mjs";
import { ensurePhase9CloudEventSchema } from "./phase9CloudEventStore.mjs";
import { ensurePhase9PressingOutboxSchema } from "./phase9PressingOutbox";
import { ensurePhase10SyncControlSchema } from "./phase10SyncControl.mjs";
import { EdgeRefusal } from "./edgeRefusal";

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
    } else {
      await ensureEdgeVoucherOutboxSchema(client);
      await ensurePhase9PressingOutboxSchema(client);
      await ensurePhase10SyncControlSchema(client);
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
