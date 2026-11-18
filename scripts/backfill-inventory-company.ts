/**
 * One-time repair: backfill inventory.company_id from locations.company_id
 * for rows where company_id is NULL or mismatched.
 *
 * Run with:
 *   npx tsx scripts/backfill-inventory-company.ts
 *
 * This is safe to run multiple times (idempotent).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function main() {
  console.log("Starting inventory.company_id backfill...");

  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt
    FROM inventory inv
    JOIN locations loc ON loc.id = inv.location_id
    WHERE inv.company_id IS NULL
       OR inv.company_id <> loc.company_id
  `);
  const affectedCount = Number(countResult.rows[0]?.cnt ?? 0);
  console.log(`Rows needing repair: ${affectedCount}`);

  if (affectedCount === 0) {
    console.log("Nothing to do — all rows already have correct company_id.");
    await pool.end();
    return;
  }

  const result = await db.execute(sql`
    UPDATE inventory inv
    SET company_id = loc.company_id
    FROM locations loc
    WHERE inv.location_id = loc.id
      AND (
        inv.company_id IS NULL
        OR inv.company_id <> loc.company_id
      )
  `);

  console.log(`Updated ${result.rowCount ?? affectedCount} inventory rows.`);
  console.log("Backfill complete.");
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
