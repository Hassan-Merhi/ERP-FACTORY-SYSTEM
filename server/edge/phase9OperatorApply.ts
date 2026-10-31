/**
 * Deliberately MANUAL Phase 9 event-stream operator entrypoint (no HTTP, no
 * timer, no startup hook). Same authority model as Phase 8: the LAN is
 * frozen, a DBA has issued a newer cloud writer epoch, and every apply runs
 * as the restricted cloud runtime role under the verified Phase 7 fence.
 *
 *   status                         per-stream staged / applied / open conflicts
 *   apply <stream>                 apply contiguous staged events; stops at the
 *                                  first conflict, which is recorded and blocks
 *   reject <stream> <sequence> <decided-by> <reason...>
 *                                  DBA decision for a recorded conflict; the next
 *                                  apply writes an auditable rejected-conflict
 *                                  receipt and the stream continues
 */
import { pool } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import {
  applyPendingStagedEvents,
  Phase9EventConflict,
  recordPhase9ConflictDecision,
  summarizePhase9CloudStreams,
} from "./phase9CloudEventStore.mjs";
import { isPhase9EventStream } from "./phase9EventProtocol.mjs";
import { phase9PressingApplyHandler } from "./phase9PressingApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../services/security/databaseScopeRuntimeContext";
import { EdgeRefusal } from "./edgeRefusal";

const SHA = /^[0-9a-f]{64}$/;
const POSITIVE = /^[1-9][0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PHASE9_HANDLERS = Object.freeze({
  "pressing.confirmation.v1": phase9PressingApplyHandler,
});

export function readPhase9OperatorConfig(env: NodeJS.ProcessEnv = process.env) {
  const edge = readFactoryEdgeConfiguration(env);
  if (
    edge.mode !== "cloud" ||
    edge.writeMode !== "fenced" ||
    env.FACTORY_SYNC_RECEIVE_ENABLED !== "1" ||
    env.FACTORY_PHASE9_APPLY_ENABLED !== "1" ||
    env.FACTORY_PHASE8_APPLY_ACK !== "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED" ||
    !UUID.test(env.FACTORY_SYNC_SITE_ID || "") ||
    !SHA.test(env.FACTORY_PHASE8_BASELINE_SHA256 || "") ||
    !POSITIVE.test(env.FACTORY_PHASE8_COMPANY_ID || "") ||
    !POSITIVE.test(env.FACTORY_CLOUD_WRITER_EPOCH || "") ||
    !Number.isSafeInteger(Number(env.FACTORY_CLOUD_WRITER_EPOCH))
  ) {
    throw new EdgeRefusal("PHASE9_OPERATOR_APPLICATION_DISABLED");
  }
  return Object.freeze({
    siteId: String(env.FACTORY_SYNC_SITE_ID),
    companyId: Number(env.FACTORY_PHASE8_COMPANY_ID),
    cloudEpoch: String(env.FACTORY_CLOUD_WRITER_EPOCH),
    baselineSha256: String(env.FACTORY_PHASE8_BASELINE_SHA256),
    operatorAck: String(env.FACTORY_PHASE8_APPLY_ACK),
  });
}

export async function runPhase9OperatorApply(stream: string) {
  if (!isPhase9EventStream(stream)) throw new EdgeRefusal("PHASE9_STREAM_INVALID");
  const config = readPhase9OperatorConfig();
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(config.companyId), async () => {
    const client = await pool.connect();
    try {
      return await applyPendingStagedEvents(client, { ...config, stream }, PHASE9_HANDLERS);
    } finally {
      client.release();
    }
  });
}

async function main(argv: string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  if (command === "status" && rest.length === 0) {
    const siteId = process.env.FACTORY_SYNC_SITE_ID || "";
    if (!UUID.test(siteId)) throw new EdgeRefusal("PHASE9_SITE_INVALID");
    return summarizePhase9CloudStreams(pool, siteId);
  }
  if (command === "apply" && rest.length === 1) return runPhase9OperatorApply(rest[0]);
  if (command === "reject" && rest.length >= 4) {
    const [stream, sequence, decidedBy, ...reason] = rest;
    const siteId = process.env.FACTORY_SYNC_SITE_ID || "";
    if (!UUID.test(siteId)) throw new EdgeRefusal("PHASE9_SITE_INVALID");
    return recordPhase9ConflictDecision(pool, { siteId, stream, sequence, decidedBy, reason: reason.join(" ") });
  }
  throw new Error("PHASE9_USAGE");
}

if (process.argv[1] && /phase9OperatorApply\.(?:ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify({ phase: 9, result })))
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "PHASE9_USAGE") {
        console.error(
          "Usage: node --import tsx server/edge/phase9OperatorApply.ts status | apply <stream> | " +
            "reject <stream> <sequence> <decided-by> <reason...>"
        );
        process.exitCode = 2;
        return;
      }
      const detail = error instanceof Phase9EventConflict ? error.detail : undefined;
      console.error("PHASE9_OPERATOR_REFUSED", error instanceof Error ? error.message : String(error), detail ?? "");
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
