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
  'import { db, pool } from "../server/db";\nimport { ensureCanonicalStockMovementJournal } from "../server/services/inventory/ensureCanonicalStockMovementJournal";\nimport { ensureFinancialOperationRequests } from "../server/services/accounting/ensureFinancialOperationRequests";',
  "phase4 test db import"
);
replaceOne(
  phase4Test,
  "beforeAll(async () => {\n  ctx = await seedTestData(PREFIX);",
  "beforeAll(async () => {\n  // cleanupTestData removes rows from runtime-managed tables that drizzle push\n  // does not create, so make those shared fixture teardown dependencies available.\n  await ensureCanonicalStockMovementJournal(pool);\n  await ensureFinancialOperationRequests(pool);\n  ctx = await seedTestData(PREFIX);",
  "phase4 runtime test tables setup"
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

// Phase 4 adds loading-capacity copy to both the Factory and ERP loading
// surfaces. These inventories are consumed by the runtime compatibility
// translator and by the enforced i18n audit, so add the new English source
// values with Arabic/French equivalents instead of increasing the untranslated
// literal baseline.
replaceOne(
  "client/src/i18n/phase3RemainingTranslations.part13.ts",
  "\n];\n",
  `\n  {\n    en: "Failed to fetch proforma capacity",\n    ar: "تعذر تحميل سعة البروفورما",\n    fr: "Impossible de charger la capacité du proforma",\n  },\n  {\n    en: "Proforma fully consumed",\n    ar: "تم استهلاك كمية البروفورما بالكامل",\n    fr: "Proforma entièrement consommé",\n  },\n  {\n    en: "No remaining quantity is available for a new loading.",\n    ar: "لا توجد كمية متبقية متاحة لعملية تحميل جديدة.",\n    fr: "Aucune quantité restante n’est disponible pour un nouveau chargement.",\n  },\n  {\n    en: "remaining across all loadings",\n    ar: "متبقية عبر جميع عمليات التحميل",\n    fr: "restant sur tous les chargements",\n  },\n  {\n    en: "Loaded (This+Other)",\n    ar: "المحمّل (هذا + الآخر)",\n    fr: "Chargé (celui-ci + autres)",\n  },\n  {\n    en: "Invalid currentOrderId",\n    ar: "معرّف طلب التحميل الحالي غير صالح",\n    fr: "Identifiant de chargement actuel invalide",\n  },\n];\n`,
  "phase4 loading translation inventory"
);
