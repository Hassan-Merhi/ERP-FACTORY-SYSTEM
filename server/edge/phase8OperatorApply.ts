/**
 * Deliberately MANUAL Phase 8 reconciliation entrypoint. It never runs from
 * HTTP, a timer, bootstrap, or startup migrations. DB schema and role grants
 * are installed separately by a DBA in an isolated rehearsal first.
 */
import { pool } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { applyStagedVoucherOnce } from "./phase8ApplyStore.mjs";
import { postApprovedPhase8Journal } from "./phase8VoucherPosting";
import { runWithDatabaseScopeRuntimeContext, createTenantDatabaseScope } from "../services/security/databaseScopeRuntimeContext";

const SHA = /^[0-9a-f]{64}$/;
const POSITIVE = /^[1-9][0-9]{0,15}$/;

export function readPhase8OperatorConfig(env: NodeJS.ProcessEnv = process.env) {
  const edge = readFactoryEdgeConfiguration(env);
  if (edge.mode !== "cloud" || edge.writeMode !== "fenced" ||
      env.FACTORY_SYNC_RECEIVE_ENABLED !== "1" ||
      env.FACTORY_PHASE8_APPLY_ENABLED !== "1" ||
      env.FACTORY_PHASE8_APPLY_ACK !== "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED" ||
      !env.FACTORY_SYNC_SITE_ID || !env.FACTORY_PHASE8_BASELINE_SHA256 ||
      !SHA.test(env.FACTORY_PHASE8_BASELINE_SHA256) ||
      !POSITIVE.test(env.FACTORY_PHASE8_COMPANY_ID || "") ||
      !POSITIVE.test(env.FACTORY_CLOUD_WRITER_EPOCH || "") ||
      !Number.isSafeInteger(Number(env.FACTORY_CLOUD_WRITER_EPOCH))) {
    throw new Error("PHASE8_OPERATOR_APPLICATION_DISABLED");
  }
  return Object.freeze({
    siteId: env.FACTORY_SYNC_SITE_ID,
    companyId: Number(env.FACTORY_PHASE8_COMPANY_ID),
    cloudEpoch: String(env.FACTORY_CLOUD_WRITER_EPOCH),
    baselineSha256: env.FACTORY_PHASE8_BASELINE_SHA256,
    operatorAck: env.FACTORY_PHASE8_APPLY_ACK,
  });
}

export async function runPhase8OperatorApply(sequence: string) {
  if (!POSITIVE.test(sequence) || BigInt(sequence) > 9223372036854775807n) {
    throw new Error("PHASE8_SEQUENCE_INVALID");
  }
  const config = readPhase8OperatorConfig();
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(config.companyId), async () => {
    const client = await pool.connect();
    try {
      return await applyStagedVoucherOnce(client, { ...config, sequence }, (sameClient, event) =>
        postApprovedPhase8Journal(sameClient, event, config.siteId)
      );
    } finally {
      client.release();
    }
  });
}

if (process.argv[1] && /phase8OperatorApply\.(?:ts|js)$/.test(process.argv[1])) {
  const sequence = process.argv[2];
  if (!sequence || process.argv.length !== 3) {
    console.error("Usage: node --import tsx server/edge/phase8OperatorApply.ts <staged-sequence>");
    process.exitCode = 2;
  } else {
    runPhase8OperatorApply(sequence).then((receipt) => {
      console.log(JSON.stringify({ phase: 8, result: receipt }));
    }).catch((err: unknown) => {
      console.error("PHASE8_APPLY_REFUSED", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }).finally(async () => {
      await pool.end();
    });
  }
}
