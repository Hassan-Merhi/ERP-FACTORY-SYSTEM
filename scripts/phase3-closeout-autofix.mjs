import fs from "node:fs";

const file = "server/services/accounting/phase3HistoricalRepair.ts";
let source = fs.readFileSync(file, "utf8");

source = source.replace(
  /\nfunction dateText\(value: unknown\): string \{\n  return String\(value \?\? ""\)\.slice\(0, 10\);\n\}\n/,
  "\n"
);

const start = source.indexOf("  const old = await client.query<{ id: number }>(");
const end = source.indexOf("\n  for (const row of workerRows) {", start);
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

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(file, source);
