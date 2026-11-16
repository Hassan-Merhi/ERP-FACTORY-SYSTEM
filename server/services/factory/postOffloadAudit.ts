import { pool } from "../../db";

export type PostOffloadPhase6AuditAction =
  | "post_offload_phase6_readiness_inspected"
  | "post_offload_phase6_preview_generated"
  | "post_offload_phase6_blocked"
  | "post_offload_phase6_failed"
  | "post_offload_phase6_verified";

export async function persistPostOffloadPhase6Audit(params: {
  action: PostOffloadPhase6AuditAction;
  companyId: number;
  userId: string;
  username?: string | null;
  status: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO audit_log
         (user_id, username, company_id, action, table_name, record_id,
          record_identifier, changes, created_at)
       VALUES ($1, $2, $3, $4, 'factory_offload_additional_charges', $5,
               $6, $7::jsonb, NOW())`,
      [
        params.userId || null,
        params.username ?? null,
        params.companyId,
        params.action,
        params.companyId,
        `post-offload phase 6 ${params.status}`,
        JSON.stringify({
          phase: 6,
          status: params.status,
          ...params.details,
        }),
      ]
    );
  } finally {
    client.release();
  }
}
