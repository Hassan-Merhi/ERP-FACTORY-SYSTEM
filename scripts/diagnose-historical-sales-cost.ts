/**
 * Read-only diagnosis of one historical sales-cost repair group.
 *
 * Run with:
 *   npx tsx scripts/diagnose-historical-sales-cost.ts --company <id> --location <id> --diagnose-item <stockItemId>
 *
 * Runs the company dry-run in a READ ONLY transaction that is rolled back and
 * prints the group's checks, the checkpoint rewind timeline (newest first), and
 * every proposal. It never writes repair runs, sales, or inventory.
 */
import { pool } from "../server/db";
import { diagnoseHistoricalSalesCostKey } from "../server/services/inventory/historicalSalesCostRepair";

function arg(name: string): number {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Missing or invalid ${name}`);
    console.error(
      "Usage: npx tsx scripts/diagnose-historical-sales-cost.ts --company <id> --location <id> --diagnose-item <stockItemId>"
    );
    process.exit(2);
  }
  return value;
}

async function main() {
  const companyId = arg("--company");
  const locationId = arg("--location");
  const stockItemId = arg("--diagnose-item");
  const result = await diagnoseHistoricalSalesCostKey({ companyId, locationId, stockItemId });

  console.log(`# Group ${companyId}/${locationId}/${stockItemId}`);
  console.log(`\n## Checks (${result.checks.length})`);
  for (const check of result.checks) {
    if (check.code === "REWIND_TIMELINE_DIAGNOSTIC") continue;
    console.log(
      [check.status, check.code, check.salesItemId ?? "", check.expected ?? "", check.actual ?? "", check.detail ?? ""]
        .join(" | ")
    );
  }
  const timeline = result.checks.find((check) => check.code === "REWIND_TIMELINE_DIAGNOSTIC");
  console.log("\n## Checkpoint rewind timeline (newest first)");
  console.log(timeline?.detail ?? "(the rewind did not reach this group)");
  console.log(`\n## Proposals (${result.proposals.length})`);
  for (const proposal of result.proposals) {
    console.log(
      [
        proposal.salesItemId,
        proposal.occurredAt,
        proposal.evidence,
        `original=${proposal.originalCostPrice}`,
        `proposed=${proposal.proposedCostPrice}`,
        proposal.changed ? "changed" : "unchanged",
      ].join(" ")
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
