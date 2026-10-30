/**
 * Read-only HTTPS receipt lookup for signed LAN senders. A staged acknowledgement
 * is never upgraded; only a committed Phase 8 cloud apply row is returned.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQ = /^[1-9][0-9]{0,18}$/;
export const PHASE8_RECEIPT_QUERY_PATH = "/api/edge/sync/applied-receipts";
export const PHASE8_RECEIPT_QUERY_PROTOCOL = "factory-lan-voucher-applied-query/v1";
export const PHASE8_RECEIPT_PROTOCOL = "factory-lan-voucher-applied-receipts/v1";

export function validateAppliedReceiptQuery(body, expectedSite) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "fromSequence,protocol,siteId" ||
      body.protocol !== PHASE8_RECEIPT_QUERY_PROTOCOL ||
      body.siteId !== expectedSite || !UUID.test(body.siteId ?? "") ||
      typeof body.fromSequence !== "string" || !SEQ.test(body.fromSequence) ||
      BigInt(body.fromSequence) > 9223372036854775807n) {
    throw new Error("PHASE8_RECEIPT_QUERY_INVALID");
  }
  return body;
}

export async function getAppliedCloudReceipts(queryable, body, expectedSite) {
  const input = validateAppliedReceiptQuery(body, expectedSite);
  const rows = await queryable.query(`
    SELECT sequence::text, operation_id::text, company_id, actor_user_id,
           local_voucher_id, cloud_voucher_id, payload_sha256,
           business_date::text
    FROM factory_edge_applied_vouchers
    WHERE site_id=$1::uuid AND sequence >= $2::bigint
    ORDER BY sequence ASC LIMIT 25
  `, [expectedSite, input.fromSequence]);
  return {
    protocol: PHASE8_RECEIPT_PROTOCOL, siteId: expectedSite,
    state: "cloud-applied",
    events: rows.rows.map((row) => ({
      sequence: String(row.sequence),
      operationId: String(row.operation_id),
      companyId: Number(row.company_id),
      actorUserId: String(row.actor_user_id),
      localVoucherId: Number(row.local_voucher_id),
      cloudVoucherId: Number(row.cloud_voucher_id),
      payloadSha256: String(row.payload_sha256).trim(),
      businessDate: String(row.business_date).slice(0, 10),
      state: "cloud-applied",
    })),
  };
}
