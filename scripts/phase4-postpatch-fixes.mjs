import fs from "node:fs";

function replaceOne(path, before, after, label) {
  const source = fs.readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(before, after));
}

const phase4Test = "tests/proforma-capacity-phase4-reconciliation.test.ts";
replaceOne(
  phase4Test,
  'import { pool } from "../server/db";',
  'import { db, pool } from "../server/db";\nimport { ensureCanonicalStockMovementJournal } from "../server/services/inventory/ensureCanonicalStockMovementJournal";',
  "phase4 test db import"
);
replaceOne(
  phase4Test,
  "beforeAll(async () => {\n  ctx = await seedTestData(PREFIX);",
  "beforeAll(async () => {\n  // cleanupTestData removes canonical journal rows; drizzle push does not create\n  // these runtime-managed tables, so make the shared fixture teardown available.\n  await ensureCanonicalStockMovementJournal(pool);\n  ctx = await seedTestData(PREFIX);",
  "phase4 canonical test journal setup"
);
replaceOne(
  phase4Test,
  "await syncProformaReservations(ctx.db, ctx.companyId, proformaId);",
  "await syncProformaReservations(db, ctx.companyId, proformaId);",
  "phase4 test db usage"
);
replaceOne(
  phase4Test,
  'const verifiedId = orders.find((row) => row.status === "VERIFIED")!.id;\n  currentOrderId = orders.find((row) => row.status === "LOADING")!.id;\n  const cancelledId = orders.find((row) => row.status === "CANCELLED")!.id;',
  'const verifiedId = orders.rows.find((row) => row.status === "VERIFIED")!.id;\n  currentOrderId = orders.rows.find((row) => row.status === "LOADING")!.id;\n  const cancelledId = orders.rows.find((row) => row.status === "CANCELLED")!.id;',
  "phase4 query result rows"
);
replaceOne(
  phase4Test,
  "expect(row.freeToPromise).toBe(row.inStock - 1);",
  "expect(row.freeToPromise).toBe(Math.max(0, row.inStock - 1));",
  "phase4 free-to-promise floor"
);

// The bilingual response resolver adds normalizedArticleCode when a record does
// not already provide one. Capacity snapshots already provide a semantic,
// lower-case normalized key, so preserve it instead of overwriting it with the
// display/canonical article code.
replaceOne(
  "server/services/factoryBilingualSurfaceResolver.ts",
  "  if (articleCode) record.normalizedArticleCode = articleCode;",
  "  if (articleCode && !clean(record.normalizedArticleCode)) record.normalizedArticleCode = articleCode;",
  "preserve semantic normalized article code"
);
