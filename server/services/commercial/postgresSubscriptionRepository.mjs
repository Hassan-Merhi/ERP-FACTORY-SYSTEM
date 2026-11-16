/**
 * Durable PostgreSQL webhook adapter.
 *
 * Caller supplies a dedicated PostgreSQL Pool for a commercial, physically
 * isolated database. This module does not open a connection by itself.
 * Both the account lock and webhook receipt are inside ONE transaction.
 */
export function makePostgresSubscriptionRepository(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A commercial PostgreSQL pool is required");
  }
  return {
    async transaction(fn) {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("BEGIN");
        inTransaction = true;
        const result = await fn({
          async lockSubscriptionByProviderId(provider, providerSubscriptionId) {
            const query = await client.query(
              `SELECT account_id AS "tenantId", provider, plan, status, sequence
                 FROM commercial_subscriptions
                 WHERE provider = $1 AND provider_subscription_id = $2
                 FOR UPDATE`,
              [provider, providerSubscriptionId],
            );
            if (query.rowCount !== 1) return null;
            const row = query.rows[0];
            return {
              tenantId: row.tenantId,
              provider: row.provider,
              plan: row.plan,
              status: row.status,
              sequence: Number(row.sequence),
            };
          },
          async insertUniqueWebhookReceipt({ provider, eventId, tenantId, eventType, occurredAtMs, eventHash }) {
            if (!/^[0-9a-f]{64}$/.test(eventHash)) {
              throw new TypeError("Event fingerprint must be SHA-256");
            }
            const query = await client.query(
              `INSERT INTO commercial_subscription_events
                 (provider,provider_event_id,account_id,verified_at,event_status,event_type,event_hash)
                 VALUES ($1,$2,$3,to_timestamp($4 / 1000.0),'received',$5,$6)
                 ON CONFLICT (provider,provider_event_id) DO NOTHING
                 RETURNING id`,
              [provider, eventId, tenantId, occurredAtMs, eventType, eventHash],
            );
            return query.rowCount === 1;
          },
          async setSubscriptionState(state) {
            const query = await client.query(
              `UPDATE commercial_subscriptions SET
                 plan=$1,status=$2,sequence=$3,updated_at=now(),
                 canceled_at=CASE WHEN $2 = 'canceled' THEN now() ELSE canceled_at END
                 WHERE account_id=$4 AND provider=$5 AND provider_subscription_id=$6 AND sequence < $3
                 RETURNING account_id`,
              [
                state.plan,
                state.status,
                state.sequence,
                state.tenantId,
                state.provider,
                state.providerSubscriptionId,
              ],
            );
            if (query.rowCount !== 1) {
              throw new Error("Concurrent subscription state conflict");
            }
          },
          async markWebhookReceipt(provider, eventId, state) {
            if (state !== "processed" && state !== "ignored") {
              throw new TypeError("Invalid event receipt state");
            }
            const query = await client.query(
              `UPDATE commercial_subscription_events
                 SET event_status=$3,processed_at=now()
                 WHERE provider=$1 AND provider_event_id=$2 AND event_status='received'
                 RETURNING id`,
              [provider, eventId, state],
            );
            if (query.rowCount !== 1) throw new Error("Webhook receipt state conflict");
          },
        });
        await client.query("COMMIT");
        inTransaction = false;
        return result;
      } catch (error) {
        if (inTransaction) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve original failure without exposing DB/connection details.
          }
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
