import fs from "node:fs";

// Temporary closeout helper: apply deterministic Phase 3 fixes and let CI verify them.
const repairFile = "server/services/accounting/phase3HistoricalRepair.ts";
let repairSource = fs.readFileSync(repairFile, "utf8");

repairSource = repairSource.replace(
  /\nfunction dateText\(value: unknown\): string \{\n  return String\(value \?\? ""\)\.slice\(0, 10\);\n\}\n/,
  "\n"
);

const start = repairSource.indexOf("  const old = await client.query<{ id: number }>(");
const end = repairSource.indexOf("\n  for (const row of workerRows) {", start);
if (start < 0 || end < 0) {
  throw new Error("Could not locate the Phase 3 payroll voucher rebuild block");
}

const replacement = `  const old = await client.query<{ id: number }>(
    \`SELECT id FROM vouchers
      WHERE company_id=$1 AND voucher_number LIKE 'PAYROLL-GEN-%'
        AND voucher_date=$2::date AND description LIKE ('%' || $3 || '%')
      ORDER BY id\`,
    [companyId, periodStart, periodEnd]
  );
  const oldIds = old.rows.map((row) => row.id);
  const voucherId = oldIds[0];
  if (!voucherId) {
    throw new Error(
      \`Phase 3 payroll repair found no existing generation voucher for \${periodStart}..\${periodEnd}\`
    );
  }

  const duplicateIds = oldIds.slice(1);
  if (duplicateIds.length > 0) {
    await client.query(
      \`DELETE FROM accounting_posting_requests WHERE company_id=$1 AND voucher_id=ANY($2::int[])\`,
      [companyId, duplicateIds]
    );
    await client.query(\`DELETE FROM voucher_entries WHERE voucher_id=ANY($1::int[])\`, [duplicateIds]);
    await client.query(\`DELETE FROM vouchers WHERE company_id=$1 AND id=ANY($2::int[])\`, [
      companyId,
      duplicateIds,
    ]);
  }

  // Historical repair owns the survivor voucher transactionally. Retire any
  // stale posting marker before changing its payload so future retries cannot
  // validate against an obsolete request fingerprint.
  await client.query(
    \`DELETE FROM accounting_posting_requests WHERE company_id=$1 AND voucher_id=$2\`,
    [companyId, voucherId]
  );

  const totalGrossCents = totalNetCents + totalAdvanceCents;
  const description = \`Payroll expense: \${payrolls.rows.length} worker\${payrolls.rows.length === 1 ? "" : "s"} (\${periodStart} – \${periodEnd})\`;
  await client.query(
    \`UPDATE vouchers
        SET voucher_type='Journal',
            voucher_date=$3::date,
            description=$4,
            total_amount=$5,
            currency='USD',
            source_module='FACTORY',
            optional=false,
            deleted_at=NULL
      WHERE company_id=$1 AND id=$2\`,
    [companyId, voucherId, periodStart, description, moneyFromCents(totalGrossCents)]
  );
  await client.query(\`DELETE FROM voucher_entries WHERE voucher_id=$1\`, [voucherId]);
`;

repairSource = repairSource.slice(0, start) + replacement + repairSource.slice(end);
fs.writeFileSync(repairFile, repairSource);

// Phase 3 inventory cutover reads canonical_stock_movements. The always-running
// canonical journal ensure must therefore precede ensureRuntimeSchema on a fresh
// database; otherwise runtime startup can reach the Phase 3 baseline before the
// canonical journal exists.
const indexFile = "server/index.ts";
let indexSource = fs.readFileSync(indexFile, "utf8");
const oldOrder = `      await ensureRuntimeSchema(pool);\n      await ensureCanonicalStockMovementJournal(pool);`;
const newOrder = `      await ensureCanonicalStockMovementJournal(pool);\n      await ensureRuntimeSchema(pool);`;
if (!indexSource.includes(oldOrder) && !indexSource.includes(newOrder)) {
  throw new Error("Could not locate canonical journal/runtime schema startup order");
}
indexSource = indexSource.replace(oldOrder, newOrder);
fs.writeFileSync(indexFile, indexSource);
