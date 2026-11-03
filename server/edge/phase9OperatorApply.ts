/**
 * Deliberately MANUAL Phase 9 event-stream operator entrypoint (no HTTP, no
 * timer, no startup hook). Same authority model as Phase 8: the LAN is
 * frozen, a DBA has issued a newer cloud writer epoch, and every apply runs
 * as the restricted cloud runtime role under the verified Phase 7 fence.
 *
 *   status                         per-stream staged / applied / open conflicts
 *   apply <stream>                 apply contiguous staged events; stops at the
 *                                  first conflict, which is recorded and blocks
 *   reject <stream> <sequence> <reviewer-username> <reason...>
 *                                  decision for a recorded conflict; the next
 *                                  apply writes an auditable rejected-conflict
 *                                  receipt and the stream continues
 *   approve <stream> <sequence> <reviewer-username> <reason...>
 *                                  apply the event anyway, only for a conflict
 *                                  its stream declares overridable (for example
 *                                  stock going below zero)
 *
 * Reviewers must be active Admin or Developer users of the approved company
 * (owner policy 2026-11-01); the username is stored with the decision.
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
import { phase9StockApplyHandler } from "./phase9StockApply";
import { phase9StockTransferApplyHandler } from "./phase9StockTransferApply";
import { phase9StockItemEditApplyHandler } from "./phase9StockItemEditApply";
import { PHASE9_STOCK_ITEM_EDIT_KIND } from "./phase9StockItemEditEnvelope.mjs";
import { phase9PosSaleApplyHandler } from "./phase9PosSaleApply";
import {
  PHASE9_POS_SALE_CANCEL_KIND,
  PHASE9_POS_SALE_EDIT_KIND,
  PHASE9_POS_SALE_KIND,
} from "./phase9PosSaleEnvelope.mjs";
import { phase9PosSaleCancelApplyHandler } from "./phase9PosSaleCancelApply";
import { recalculateIntercompanyForDate } from "../routes/helpers/intercompanyHelpers";
import { phase9PosSaleEditApplyHandler } from "./phase9PosSaleEditApply";
import { phase9ReceivingApplyHandler } from "./phase9ReceivingApply";
import { PHASE9_RECEIVING_KIND } from "./phase9ReceivingEnvelope.mjs";
import { phase9AttachmentApplyHandler } from "./phase9AttachmentApply";
import { PHASE9_ATTACHMENT_KIND } from "./phase9AttachmentEnvelope.mjs";
import { phase9PaymentApplyHandler } from "./phase9PaymentApply";
import { PHASE9_PAYMENT_KIND } from "./phase9PaymentEnvelope.mjs";
import { PHASE9_STOCK_ADJUST_KIND, PHASE9_STOCK_TRANSFER_KIND } from "./phase9StockEnvelope.mjs";
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
  [PHASE9_STOCK_ADJUST_KIND]: phase9StockApplyHandler,
  [PHASE9_STOCK_TRANSFER_KIND]: phase9StockTransferApplyHandler,
  [PHASE9_STOCK_ITEM_EDIT_KIND]: phase9StockItemEditApplyHandler,
  [PHASE9_POS_SALE_KIND]: phase9PosSaleApplyHandler,
  [PHASE9_POS_SALE_EDIT_KIND]: phase9PosSaleEditApplyHandler,
  [PHASE9_POS_SALE_CANCEL_KIND]: phase9PosSaleCancelApplyHandler,
  [PHASE9_RECEIVING_KIND]: phase9ReceivingApplyHandler,
  [PHASE9_ATTACHMENT_KIND]: phase9AttachmentApplyHandler,
  [PHASE9_PAYMENT_KIND]: phase9PaymentApplyHandler,
});

const REVIEWER_ROLES = ["Admin", "Developer"];

/** Only an active Admin/Developer of the approved company may decide a conflict. */
export async function assertPhase9Reviewer(
  queryable: { query: typeof pool.query },
  companyId: number,
  username: string
): Promise<string> {
  const result = await queryable.query(
    `SELECT u.username FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $1
      WHERE u.username = $2 AND u.active = true AND r.role = ANY($3::text[])
      LIMIT 1`,
    [companyId, username, REVIEWER_ROLES]
  );
  if (result.rows.length !== 1) throw new EdgeRefusal("PHASE9_REVIEWER_NOT_AUTHORIZED");
  return String(result.rows[0].username);
}

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
    let receipts;
    try {
      receipts = await applyPendingStagedEvents(client, { ...config, stream }, PHASE9_HANDLERS);
    } finally {
      client.release();
    }
    // After commit, as the live delete route does: a cancelled sale leaves the
    // intercompany POS mirror for its date (the rebuild never throws).
    const cancelledDates = new Set(
      receipts
        .filter((receipt) => receipt.kind === PHASE9_POS_SALE_CANCEL_KIND && receipt.outcome === "cloud-applied")
        .map((receipt) => String(receipt.businessDate))
    );
    for (const date of cancelledDates) await recalculateIntercompanyForDate(config.companyId, date);
    return receipts;
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
  if ((command === "reject" || command === "approve") && rest.length >= 4) {
    const [stream, sequence, reviewer, ...reason] = rest;
    const siteId = process.env.FACTORY_SYNC_SITE_ID || "";
    if (!UUID.test(siteId)) throw new EdgeRefusal("PHASE9_SITE_INVALID");
    const companyId = process.env.FACTORY_PHASE8_COMPANY_ID || "";
    if (!POSITIVE.test(companyId)) throw new EdgeRefusal("PHASE9_COMPANY_INVALID");
    const decidedBy = await assertPhase9Reviewer(pool, Number(companyId), reviewer);
    return recordPhase9ConflictDecision(pool, {
      siteId,
      stream,
      sequence,
      decidedBy,
      reason: reason.join(" "),
      decision: command === "approve" ? "approve-override" : "reject-event",
    });
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
            "reject|approve <stream> <sequence> <reviewer-username> <reason...>"
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
