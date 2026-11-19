/**
 * Full offline mode: entries a PC makes offline that change a record it
 * already has (Payment / Receipt edits and deletes so far).
 *
 * The live route computes the same evidence the factory LAN server records
 * (including the record as it stood, `beforeSha256`) inside the business
 * transaction. On a PC in entry mode that evidence is written to
 * pc_local.outbox in the SAME transaction, already as the finished envelope,
 * so the entry and its record commit or roll back together. The cloud checks
 * that the envelope names the signed-in person and company, then applies it
 * through the same exactly-once handlers.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { pcLocalMode } from "./pcLocalMode";

/** Rows the PC creates itself start here (pc_local.use_local_id_range). */
export const PC_LOCAL_ID_BASE = 1_000_000_000;

export function pcLocalEntryMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return pcLocalMode(env) === "entry";
}

/** A record made on this PC (not yet in the cloud) carries a local id. */
export function isPcLocalId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= PC_LOCAL_ID_BASE;
}

/** Writes a finished envelope to the PC's outbox inside the route's own transaction. */
export async function capturePcLocalEnvelopeTx(
  tx: DbTransaction,
  envelope: { kind: string; requestId: string; companyId: number; actorUserId: string },
  localRef: number
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO pc_local.outbox (operation_id, kind, input, envelope, local_ref, user_id, company_id, status)
    VALUES (${envelope.requestId}::uuid, ${envelope.kind}, '{}'::jsonb, ${JSON.stringify(envelope)}::jsonb,
            ${localRef}, ${envelope.actorUserId}, ${envelope.companyId}, 'pending')
  `);
}
