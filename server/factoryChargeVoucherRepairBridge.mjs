import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "./lib/databaseSsl.mjs";

const { Client } = pg;
const INSTALL_KEY = Symbol.for("erp.factory-charge-voucher-repair.applied");
const STARTUP_LOCK_KEY = 741_220_263;

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    return `postgresql://${encodeURIComponent(process.env.PGUSER)}:${encodeURIComponent(process.env.PGPASSWORD)}@${process.env.PGHOST}:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE}`;
  }
  return "";
}

function log(level, message, extra = {}) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      module: "factory-charge-voucher-repair",
      action: "startup-reconcile",
      ...extra,
    })
  );
}

export async function repairMissingVerifiedChargeVouchers() {
  const connectionString = resolveConnectionString();
  if (!connectionString) {
    log("WARN", "Skipping factory charge voucher repair because no PostgreSQL configuration is available");
    return;
  }

  const client = new Client({
    connectionString,
    ssl: resolveDatabaseSsl(connectionString),
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK_KEY]);
    await client.query(
      `SELECT
         set_config('app.company_scope_maintenance', 'on', true),
         set_config('app.current_company_id', '', true),
         set_config('app.authorized_company_ids', '', true)`
    );

    const missing = await client.query(`
      SELECT
        c.id AS charge_id,
        c.order_id,
        c.name AS charge_name,
        c.amount::numeric::text AS amount,
        c.ledger_account_id AS charge_ledger_account_id,
        co.company_id,
        co.customer_id,
        co.container_number,
        co.order_date,
        cu.legal_name AS customer_name,
        cu.ledger_account_id AS customer_ledger_account_id
      FROM customer_order_charges c
      JOIN customer_orders co ON co.id = c.order_id
      JOIN customers cu ON cu.id = co.customer_id AND cu.company_id = co.company_id
      WHERE co.status IN ('PENDING_VERIFICATION', 'VERIFIED')
        AND c.voucher_id IS NULL
        AND c.ledger_account_id IS NOT NULL
        AND COALESCE(c.amount, 0)::numeric > 0
      ORDER BY co.company_id, c.order_id, c.id
      FOR UPDATE OF c
    `);

    let repaired = 0;
    let linkedExisting = 0;
    let createdCustomerLedgers = 0;

    for (const row of missing.rows) {
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      let customerLedgerAccountId = row.customer_ledger_account_id;
      if (!customerLedgerAccountId) {
        const customerCode = `CUST-${row.customer_id}`.slice(0, 50);
        const existingCustomerLedger = await client.query(
          `SELECT id
             FROM ledger_accounts
            WHERE company_id = $1 AND code = $2
            ORDER BY id
            LIMIT 1
            FOR UPDATE`,
          [row.company_id, customerCode]
        );

        if (existingCustomerLedger.rows[0]?.id) {
          customerLedgerAccountId = existingCustomerLedger.rows[0].id;
        } else {
          const createdLedger = await client.query(
            `INSERT INTO ledger_accounts
               (company_id, code, name, account_type, active, is_hidden)
             VALUES ($1, $2, $3, 'Asset', true, false)
             RETURNING id`,
            [row.company_id, customerCode, row.customer_name || `Customer ${row.customer_id}`]
          );
          customerLedgerAccountId = createdLedger.rows[0].id;
          createdCustomerLedgers++;
        }

        await client.query(
          `UPDATE customers
              SET ledger_account_id = $1
            WHERE id = $2 AND company_id = $3 AND ledger_account_id IS NULL`,
          [customerLedgerAccountId, row.customer_id, row.company_id]
        );
      }

      const voucherNumber = `CHARGE-PRE-${row.order_id}-${row.charge_id}`;
      const description = row.container_number
        ? `${row.charge_name} for container - ${row.container_number}`
        : `${row.charge_name} - Order #${row.order_id}`;

      const existingVoucher = await client.query(
        `SELECT id, deleted_at
           FROM vouchers
          WHERE company_id = $1 AND voucher_number = $2
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        [row.company_id, voucherNumber]
      );

      let voucherId;
      if (existingVoucher.rows[0]?.id && !existingVoucher.rows[0].deleted_at) {
        voucherId = existingVoucher.rows[0].id;
        linkedExisting++;
      } else if (existingVoucher.rows[0]?.id) {
        voucherId = existingVoucher.rows[0].id;
        await client.query(
          `UPDATE vouchers
              SET deleted_at = NULL,
                  voucher_type = 'Journal',
                  voucher_date = $1,
                  description = $2,
                  total_amount = $3,
                  source_module = 'FACTORY'
            WHERE id = $4`,
          [row.order_date, description, String(amount), voucherId]
        );
        await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [voucherId]);
        await client.query(
          `INSERT INTO voucher_entries
             (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount, narration)
           VALUES
             ($1, $2, $3, $4, '0', $6),
             ($1, $5, NULL, '0', $4, $6)`,
          [
            voucherId,
            customerLedgerAccountId,
            row.customer_id,
            String(amount),
            row.charge_ledger_account_id,
            description,
          ]
        );
        repaired++;
      } else {
        const createdVoucher = await client.query(
          `INSERT INTO vouchers
             (company_id, voucher_type, voucher_number, voucher_date, description, total_amount, source_module)
           VALUES ($1, 'Journal', $2, $3, $4, $5, 'FACTORY')
           RETURNING id`,
          [row.company_id, voucherNumber, row.order_date, description, String(amount)]
        );
        voucherId = createdVoucher.rows[0].id;

        await client.query(
          `INSERT INTO voucher_entries
             (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount, narration)
           VALUES
             ($1, $2, $3, $4, '0', $6),
             ($1, $5, NULL, '0', $4, $6)`,
          [
            voucherId,
            customerLedgerAccountId,
            row.customer_id,
            String(amount),
            row.charge_ledger_account_id,
            description,
          ]
        );
        repaired++;
      }

      await client.query(
        `UPDATE customer_order_charges
            SET voucher_id = $1
          WHERE id = $2 AND order_id = $3 AND voucher_id IS NULL`,
        [voucherId, row.charge_id, row.order_id]
      );
    }

    const remaining = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM customer_order_charges c
      JOIN customer_orders co ON co.id = c.order_id
      WHERE co.status IN ('PENDING_VERIFICATION', 'VERIFIED')
        AND c.voucher_id IS NULL
        AND c.ledger_account_id IS NOT NULL
        AND COALESCE(c.amount, 0)::numeric > 0
    `);

    await client.query("COMMIT");
    log("INFO", "Factory charge voucher reconciliation complete", {
      candidates: missing.rowCount,
      repaired,
      linkedExisting,
      createdCustomerLedgers,
      remainingMissing: remaining.rows[0]?.count ?? 0,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    log("ERROR", "Factory charge voucher repair failed", {
      errorCode: error?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  await repairMissingVerifiedChargeVouchers();
}
