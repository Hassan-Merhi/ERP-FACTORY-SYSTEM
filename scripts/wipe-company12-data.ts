import { pool } from "../server/db";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY_ID = 12;

const ROOTS = [
  "vouchers",
  "inventory",
  "factory_containers",
  "factory_container_plans",
  "factory_raw_stock",
  "factory_bales",
  "factory_container_commissions",
  "factory_fx_allocations",
  "factory_fx_rates",
  "factory_daybook_entries",
  "factory_bale_waste_dispatches",
  "bale_label_prints",
  "bale_recode_sessions",
  "factory_shipping_availability",
  "factory_shipping_container_documents",
  "factory_shipping_container_rows",
  "factory_bale_sequences",
  "customer_orders",
  "customer_proformas",
  "customer_order_expected_lines",
  "customer_balances",
  "customer_invoice_sequences",
  "audit_log",
  "login_history",
  "user_activity_log",
  "user_presence",
  "factory_worker_advances",
  "factory_payrolls",
  "_orphan_archive_factory_container_commissions_container_id",
  "_orphan_archive_factory_fx_allocations_container_id",
  "_orphan_archive_factory_raw_stock_container_id",
];

async function main() {
  const apply = process.argv.includes("--apply");

  // 1. Fetch all FK constraints in the public schema
  const fkRes = await pool.query(`
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  const childrenOfParent: Record<string, { child: string; col: string; parentCol: string }[]> = {};
  for (const row of fkRes.rows) {
    (childrenOfParent[row.parent_table] ||= []).push({
      child: row.child_table,
      col: row.child_column,
      parentCol: row.parent_column,
    });
  }

  // 2. BFS from roots to find every table transitively affected, building a SQL condition per table
  type Included = { table: string; conditions: string[] };
  const included = new Map<string, string[]>();
  for (const r of ROOTS) {
    included.set(r, [`company_id = ${COMPANY_ID}`]);
  }
  const order: string[] = [...ROOTS]; // discovery order (roots first)
  let frontier = [...ROOTS];
  const visitedEdges = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parent of frontier) {
      const parentConds = included.get(parent)!;
      const parentWhere = parentConds.join(" OR ");
      const kids = childrenOfParent[parent] || [];
      for (const k of kids) {
        const edgeKey = `${parent}->${k.child}.${k.col}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);
        const cond = `${k.col} IN (SELECT ${k.parentCol} FROM ${parent} WHERE ${parentWhere})`;
        if (!included.has(k.child)) {
          included.set(k.child, [cond]);
          order.push(k.child);
          next.push(k.child);
        } else {
          // Table already included (possibly as its own root, or via another path).
          // If it's a root (has a company_id = N condition already), leave as-is (broader).
          const existing = included.get(k.child)!;
          if (!existing.includes(`company_id = ${COMPANY_ID}`) && !existing.includes(cond)) {
            existing.push(cond);
            next.push(k.child); // re-traverse in case its own children need widening too
          }
        }
      }
    }
    frontier = next;
  }

  // 3. Topological sort: children must be deleted before parents.
  // Build edge list restricted to tables in `included`.
  const inIncluded = (t: string) => included.has(t);
  const edges: { child: string; parent: string }[] = [];
  for (const parent of included.keys()) {
    for (const k of childrenOfParent[parent] || []) {
      if (inIncluded(k.child)) edges.push({ child: k.child, parent });
    }
  }
  // Kahn's algorithm: delete order = children first. An edge child->parent means child must be deleted before parent.
  const allTables = [...included.keys()];
  const inDegree = new Map<string, number>(allTables.map((t) => [t, 0]));
  const adj = new Map<string, string[]>(allTables.map((t) => [t, []]));
  for (const e of edges) {
    // "parent depends on child being deleted first" => edge child -> parent in dependency graph
    adj.get(e.child)!.push(e.parent);
    inDegree.set(e.parent, (inDegree.get(e.parent) || 0) + 1);
  }
  const queue = allTables.filter((t) => (inDegree.get(t) || 0) === 0);
  const deletionOrder: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    deletionOrder.push(t);
    for (const next of adj.get(t) || []) {
      inDegree.set(next, (inDegree.get(next) || 0) - 1);
      if ((inDegree.get(next) || 0) <= 0 && !seen.has(next)) queue.push(next);
    }
  }
  // Safety: if cycle detected, append any remaining tables at the end (best effort)
  for (const t of allTables) if (!seen.has(t)) deletionOrder.push(t);

  console.log(
    `\n${apply ? "APPLYING" : "DRY RUN"} — deletion plan for company_id=${COMPANY_ID} (${deletionOrder.length} tables):\n`,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let totalDeleted = 0;
    for (const table of deletionOrder) {
      const conds = included.get(table)!;
      const where = conds.join(" OR ");
      const countRes = await client.query(`SELECT count(*) FROM ${table} WHERE ${where}`);
      const count = parseInt(countRes.rows[0].count, 10);
      if (count === 0) continue;
      if (apply) {
        const delRes = await client.query(`DELETE FROM ${table} WHERE ${where}`);
        console.log(`  DELETE ${table}: ${delRes.rowCount} rows`);
        totalDeleted += delRes.rowCount || 0;
      } else {
        console.log(`  WOULD DELETE ${table}: ${count} rows`);
        totalDeleted += count;
      }
    }
    console.log(`\nTotal rows ${apply ? "deleted" : "to delete"}: ${totalDeleted}`);

    if (apply) {
      // Zero balance fields on kept master data
      const r1 = await client.query(
        `UPDATE ledger_accounts SET opening_balance = '0' WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  ZEROED ledger_accounts.opening_balance: ${r1.rowCount} rows`);
      const r2 = await client.query(
        `UPDATE factory_suppliers SET opening_balance = '0' WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  ZEROED factory_suppliers.opening_balance: ${r2.rowCount} rows`);
      const r3 = await client.query(
        `UPDATE customers SET opening_balance = '0' WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  ZEROED customers.opening_balance: ${r3.rowCount} rows`);
      const r4 = await client.query(
        `UPDATE stock_items SET opening_qty = '0', opening_rate = '0', opening_value = '0' WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  ZEROED stock_items opening qty/rate/value: ${r4.rowCount} rows`);
      const r5 = await client.query(
        `UPDATE reference_sequences SET next_number = 0 WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  RESET reference_sequences.next_number: ${r5.rowCount} rows`);
      const r6 = await client.query(
        `UPDATE employees SET opening_balance = '0', current_balance = '0', total_deposits = '0', total_withdrawals = '0' WHERE company_id = $1`,
        [COMPANY_ID],
      );
      console.log(`  ZEROED employees balances: ${r6.rowCount} rows`);

      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN ONLY — rolled back, no changes made. Re-run with --apply to execute.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("ERROR — rolled back:", e);
    throw e;
  } finally {
    client.release();
  }
  process.exit(0);
}

runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY_ID), main).catch((error) => {
  console.error("Company 12 wipe failed:", error);
  process.exit(1);
});
