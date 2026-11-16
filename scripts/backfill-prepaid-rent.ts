/**
 * backfill-prepaid-rent.ts
 *
 * One-time corrective backfill for existing property_monthly_ledger rows where
 * a future month was already paid in advance BEFORE the prepaid-rent feature
 * existed.  Those rows were posted to Rent Expense (tenant) or Rent Income
 * (landlord) immediately.  This script:
 *
 *   Tenant (SHOP / shared-contract) rows:
 *     Posts:  Dr Prepaid Rent (Asset) / Cr Rent Expense
 *     Effect: Moves the amount out of expenses and onto the balance sheet
 *             until Pass 2 recognition fires when the month becomes due.
 *
 *   Landlord (non-SHOP owned contract) rows:
 *     Posts:  Dr Rent Income / Cr Deferred Rent Revenue (Liability)
 *     Effect: Reverses the premature income and parks it as a liability
 *             until Pass 3 recognition fires when the month becomes due.
 *
 * After journals are posted, each row is marked used_prepaid_account = true
 * so the accrual engine treats it as prepaid going forward.
 *
 * Idempotent: rows already flagged are skipped.  Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/backfill-prepaid-rent.ts [--dry-run]
 */

import "dotenv/config";
import { Pool, PoolClient } from "pg";

const dryRun = process.argv.includes("--dry-run");

interface LedgerRow {
  id: number;
  company_id: number;
  contract_id: number;
  unit_id: number;
  year: number;
  month: number;
  expected_amount: string;
  paid_amount: string;
  module: string;
}

interface LedgerAccount {
  id: number;
  name: string;
  account_type: string;
}

/** Find or create a ledger account by name within a company. */
async function findOrCreateAccount(
  client: PoolClient,
  companyId: number,
  name: string,
  accountType: string,
  codePrefix: string,
  subType?: string,
): Promise<number> {
  const code = `${codePrefix}-BACKFILL-${Date.now()}`;
  await client.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (company_id, name) WHERE deleted_at IS NULL DO NOTHING`,
    [companyId, code, name, accountType, subType ?? null],
  );
  const { rows } = await client.query<LedgerAccount>(
    `SELECT id, name, account_type FROM ledger_accounts
     WHERE company_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
    [companyId, name],
  );
  if (rows.length === 0) throw new Error(`Could not find/create ledger account: ${name} for company ${companyId}`);
  // Patch type if stale
  if (rows[0].account_type !== accountType) {
    await client.query(
      `UPDATE ledger_accounts SET account_type = $1 WHERE id = $2`,
      [accountType, rows[0].id],
    );
  }
  return rows[0].id;
}

/** Look up the expense account name for a SHOP contract's company by scanning existing ledger accounts. */
async function guessExpenseAccountName(client: PoolClient, companyId: number): Promise<string> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM ledger_accounts
     WHERE company_id = $1 AND account_type IN ('Indirect Expense', 'Expense')
       AND (name ILIKE '%rent%shop%' OR name ILIKE '%shop%rent%' OR code LIKE 'SHOP-RENT-EXP%')
       AND deleted_at IS NULL
     ORDER BY id ASC LIMIT 1`,
    [companyId],
  );
  return rows[0]?.name ?? "Rent Expense - Shops";
}

/** Look up the income account name for a landlord contract's company. */
async function guessIncomeAccountName(client: PoolClient, companyId: number): Promise<string> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM ledger_accounts
     WHERE company_id = $1 AND account_type IN ('Income', 'Indirect Income')
       AND (name ILIKE '%rental%income%' OR name ILIKE '%rent%income%' OR code LIKE 'RENT-INC%')
       AND deleted_at IS NULL
     ORDER BY id ASC LIMIT 1`,
    [companyId],
  );
  return rows[0]?.name ?? "Rental Income";
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const now = new Date();
    const curYear  = now.getUTCFullYear();
    const curMonth = now.getUTCMonth() + 1;

    // ── Step 1: Find candidate rows ──────────────────────────────────────────
    // Future months that are paid but NOT yet flagged as prepaid.
    const { rows: candidates } = await client.query<LedgerRow>(`
      SELECT
        pml.id, pml.company_id, pml.contract_id, pml.unit_id,
        pml.year, pml.month, pml.expected_amount, pml.paid_amount, pml.module
      FROM property_monthly_ledger pml
      WHERE pml.used_prepaid_account = false
        AND pml.accrual_voucher_id IS NULL
        AND pml.paid_amount::numeric > 0
        AND pml.expected_amount::numeric > 0
        AND (
          pml.year > $1
          OR (pml.year = $1 AND pml.month > $2)
        )
      ORDER BY pml.company_id, pml.contract_id, pml.year, pml.month
    `, [curYear, curMonth]);

    if (candidates.length === 0) {
      console.log("No prepaid ledger rows found — nothing to backfill.");
      return;
    }
    console.log(`Found ${candidates.length} candidate row(s) across ${new Set(candidates.map(r => r.company_id)).size} company(ies).`);

    // ── Step 2: Classify each row as tenant or landlord ──────────────────────
    // Tenant  = contract is linked to this company as a shared renter OR the unit is type=SHOP
    // Landlord = company owns the unit (non-SHOP unit in their own module)
    const contractIds = [...new Set(candidates.map(r => r.contract_id))];
    const { rows: contractRows } = await client.query<{
      id: number; unit_type: string; linked_company_id: number | null;
    }>(
      `SELECT pc.id, pu.unit_type, pc.linked_company_id
       FROM property_contracts pc
       JOIN property_units pu ON pu.id = pc.unit_id
       WHERE pc.id = ANY($1::int[])`,
      [contractIds],
    );
    const contractMeta = new Map(contractRows.map(r => [r.id, r]));

    const tenantRows    = candidates.filter(r => {
      const meta = contractMeta.get(r.contract_id);
      if (!meta) return false;
      // Shared contract: this company is the linked tenant
      if (meta.linked_company_id !== null) return true;
      // SHOP unit: this company is the tenant
      return meta.unit_type === "SHOP";
    });
    const landlordRows  = candidates.filter(r => {
      const meta = contractMeta.get(r.contract_id);
      if (!meta) return false;
      if (meta.linked_company_id !== null) return false; // shared → tenant side
      return meta.unit_type !== "SHOP";
    });

    console.log(`  Tenant rows:   ${tenantRows.length}`);
    console.log(`  Landlord rows: ${landlordRows.length}`);

    if (dryRun) {
      console.log("\n[DRY-RUN] Tenant rows:");
      for (const r of tenantRows) {
        console.log(`  company=${r.company_id} contract=${r.contract_id} ${String(r.month).padStart(2,"0")}/${r.year} paid=${r.paid_amount} expected=${r.expected_amount}`);
      }
      console.log("[DRY-RUN] Landlord rows:");
      for (const r of landlordRows) {
        console.log(`  company=${r.company_id} contract=${r.contract_id} ${String(r.month).padStart(2,"0")}/${r.year} paid=${r.paid_amount} expected=${r.expected_amount}`);
      }
      return;
    }

    // ── Step 3: Group by company and post reclassification journals ──────────
    // Group tenant rows by company
    const tenantByCompany = new Map<number, LedgerRow[]>();
    for (const r of tenantRows) {
      if (!tenantByCompany.has(r.company_id)) tenantByCompany.set(r.company_id, []);
      tenantByCompany.get(r.company_id)!.push(r);
    }
    const landlordByCompany = new Map<number, LedgerRow[]>();
    for (const r of landlordRows) {
      if (!landlordByCompany.has(r.company_id)) landlordByCompany.set(r.company_id, []);
      landlordByCompany.get(r.company_id)!.push(r);
    }

    let totalPosted = 0;

    // ── Tenant: Dr Prepaid Rent / Cr Rent Expense ────────────────────────────
    for (const [companyId, rows] of tenantByCompany) {
      await client.query("BEGIN");
      try {
        const expenseAccountName = await guessExpenseAccountName(client, companyId);
        const expenseId = await findOrCreateAccount(client, companyId, expenseAccountName, "Indirect Expense", "SHOP-RENT-EXP");
        const prepaidId = await findOrCreateAccount(client, companyId, "Prepaid Rent", "Asset", "PREP-RENT");

        // Determine dominant currency
        const { rows: curRows } = await client.query<{ currency: string; cnt: string }>(
          `SELECT COALESCE(currency, 'USD') AS currency, COUNT(*) AS cnt
           FROM property_contracts WHERE id = ANY($1::int[])
           GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
          [[...new Set(rows.map(r => r.contract_id))]],
        );
        const currency = curRows[0]?.currency ?? "USD";

        const totalPaid = rows.reduce((s, r) => s + Math.min(Number(r.paid_amount), Number(r.expected_amount)), 0);
        const months = [...new Set(rows.map(r => `${String(r.month).padStart(2,"0")}/${r.year}`))].sort();
        const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length-1]}`;
        const vDesc = `Prepaid rent reclassification (backfill) - company ${companyId} - ${periodLabel}`;
        const vNumber = `PREP-RENT-BACKFILL-${companyId}-${Date.now()}`;
        const today = new Date().toISOString().slice(0, 10);

        // Module from first row
        const moduleVal = rows[0].module;

        const { rows: [v] } = await client.query<{ id: number }>(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
           VALUES ($1, $2, 'Journal', $3, $4, $5, $6, $7) RETURNING id`,
          [companyId, vNumber, today, vDesc, totalPaid.toFixed(2), currency, moduleVal],
        );

        // One Dr Prepaid Rent credit row per ledger row + single Cr Rent Expense row
        for (const r of rows) {
          const paid = Math.min(Number(r.paid_amount), Number(r.expected_amount));
          if (paid < 0.005) continue;
          const rowLabel = `${String(r.month).padStart(2,"0")}/${r.year} contract=${r.contract_id}`;
          // Dr Prepaid Rent
          await client.query(
            `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
             VALUES ($1, $2, $3, '0', $4)`,
            [v.id, prepaidId, paid.toFixed(2), `Prepaid rent backfill - ${rowLabel}`],
          );
        }
        // Cr Rent Expense (combined)
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
           VALUES ($1, $2, '0', $3, $4)`,
          [v.id, expenseId, totalPaid.toFixed(2), vDesc],
        );

        // Mark all rows as usedPrepaidAccount=true
        const ids = rows.map(r => r.id);
        await client.query(
          `UPDATE property_monthly_ledger SET used_prepaid_account = true WHERE id = ANY($1::int[])`,
          [ids],
        );

        await client.query("COMMIT");
        console.log(`[Tenant]   company=${companyId} rows=${rows.length} voucher=${v.id} amount=${totalPaid.toFixed(2)} ${currency}`);
        totalPosted += rows.length;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`[Tenant]   company=${companyId} FAILED:`, e instanceof Error ? e.message : String(e));
      }
    }

    // ── Landlord: Dr Rent Income / Cr Deferred Rent Revenue ─────────────────
    for (const [companyId, rows] of landlordByCompany) {
      await client.query("BEGIN");
      try {
        const incomeAccountName = await guessIncomeAccountName(client, companyId);
        const incomeId   = await findOrCreateAccount(client, companyId, incomeAccountName, "Income", "RENT-INC", "Indirect Income");
        const deferredId = await findOrCreateAccount(client, companyId, "Deferred Rent Revenue", "Liability", "DEF-RENT-REV");

        const { rows: curRows } = await client.query<{ currency: string; cnt: string }>(
          `SELECT COALESCE(currency, 'USD') AS currency, COUNT(*) AS cnt
           FROM property_contracts WHERE id = ANY($1::int[])
           GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
          [[...new Set(rows.map(r => r.contract_id))]],
        );
        const currency = curRows[0]?.currency ?? "USD";

        const totalDeferred = rows.reduce((s, r) => s + Math.min(Number(r.paid_amount), Number(r.expected_amount)), 0);
        const months = [...new Set(rows.map(r => `${String(r.month).padStart(2,"0")}/${r.year}`))].sort();
        const periodLabel = months.length === 1 ? months[0] : `${months[0]}–${months[months.length-1]}`;
        const vDesc = `Deferred rent reclassification (backfill) - company ${companyId} - ${periodLabel}`;
        const vNumber = `DEF-RENT-BACKFILL-${companyId}-${Date.now()}`;
        const today = new Date().toISOString().slice(0, 10);
        const moduleVal = rows[0].module;

        const { rows: [v] } = await client.query<{ id: number }>(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount, currency, source_module)
           VALUES ($1, $2, 'Journal', $3, $4, $5, $6, $7) RETURNING id`,
          [companyId, vNumber, today, vDesc, totalDeferred.toFixed(2), currency, moduleVal],
        );

        // Dr Rent Income (combined)
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
           VALUES ($1, $2, $3, '0', $4)`,
          [v.id, incomeId, totalDeferred.toFixed(2), vDesc],
        );
        // One Cr Deferred Rent Revenue per row
        for (const r of rows) {
          const deferred = Math.min(Number(r.paid_amount), Number(r.expected_amount));
          if (deferred < 0.005) continue;
          const rowLabel = `${String(r.month).padStart(2,"0")}/${r.year} contract=${r.contract_id}`;
          await client.query(
            `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
             VALUES ($1, $2, '0', $3, $4)`,
            [v.id, deferredId, deferred.toFixed(2), `Deferred rent backfill - ${rowLabel}`],
          );
        }

        const ids = rows.map(r => r.id);
        await client.query(
          `UPDATE property_monthly_ledger SET used_prepaid_account = true WHERE id = ANY($1::int[])`,
          [ids],
        );

        await client.query("COMMIT");
        console.log(`[Landlord] company=${companyId} rows=${rows.length} voucher=${v.id} amount=${totalDeferred.toFixed(2)} ${currency}`);
        totalPosted += rows.length;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`[Landlord] company=${companyId} FAILED:`, e instanceof Error ? e.message : String(e));
      }
    }

    console.log(`\nBackfill complete — ${totalPosted} row(s) processed.`);
    console.log("Run POST /api/{erp|properties|factory}/rental/accrue for each affected company to trigger recognition journals.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
