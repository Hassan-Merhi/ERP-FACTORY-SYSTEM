import { sql } from "drizzle-orm";
import { db } from "../db";

export interface FactoryBilingualSnapshotTarget {
  table: string;
  arabicColumn: string;
  englishColumn: string;
  companyExpression: string;
  productIdExpression: string;
  articleCodeExpression: string;
  finalizedExpression?: string;
}

export interface FactoryBilingualSnapshotPlanRow {
  table: string;
  arabicColumn: string;
  missing: number;
  resolvable: number;
  orphaned: number;
  finalized: number;
}

export interface FactoryBilingualSnapshotPlan {
  companyId: number;
  totals: { missing: number; resolvable: number; orphaned: number; finalized: number };
  targets: FactoryBilingualSnapshotPlanRow[];
}

export interface FactoryBilingualSnapshotScope {
  orderId?: number;
  /** Exact customer_order_bales row changed by a compact bale scan. */
  orderBaleId?: number;
  /** Exact customer_order_lines row recalculated by a compact bale scan. */
  orderLineId?: number;
  proformaId?: number;
  baleId?: number;
  posSaleId?: number;
  v3LoadId?: number;
  invoiceLoadingId?: number;
  dispatchBatchId?: number;
  recodeSessionId?: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SQL_RELATION_REFERENCE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi;

const target = (
  value: Omit<FactoryBilingualSnapshotTarget, "productIdExpression" | "articleCodeExpression"> &
    Partial<Pick<FactoryBilingualSnapshotTarget, "productIdExpression" | "articleCodeExpression">>
): FactoryBilingualSnapshotTarget => ({
  productIdExpression: "NULL",
  articleCodeExpression: "NULL",
  ...value,
});

export const FACTORY_BILINGUAL_SNAPSHOT_TARGETS: FactoryBilingualSnapshotTarget[] = [
  target({
    table: "factory_bales",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "t.company_id",
    productIdExpression: "t.product_id",
    articleCodeExpression: "t.article_code",
    finalizedExpression: "t.finalized_at IS NOT NULL OR t.status IN ('FINALIZED','SOLD','DISPATCHED')",
  }),
  target({
    table: "customer_proforma_lines",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT p.company_id FROM customer_proformas p WHERE p.id=t.proforma_id)",
    articleCodeExpression: "t.article_code",
    finalizedExpression: "false",
  }),
  target({
    table: "customer_order_lines",
    arabicColumn: "bale_name_ar",
    englishColumn: "bale_name",
    companyExpression: "(SELECT o.company_id FROM customer_orders o WHERE o.id=t.order_id)",
    articleCodeExpression: "t.article_code",
    finalizedExpression:
      "EXISTS (SELECT 1 FROM customer_orders o WHERE o.id=t.order_id AND o.status IN ('FINALIZED','INVOICED','COMPLETED','CANCELLED'))",
  }),
  target({
    table: "customer_order_bales",
    arabicColumn: "bale_name_ar",
    englishColumn: "bale_name",
    companyExpression: "(SELECT o.company_id FROM customer_orders o WHERE o.id=t.order_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression:
      "EXISTS (SELECT 1 FROM customer_orders o WHERE o.id=t.order_id AND o.status IN ('FINALIZED','INVOICED','COMPLETED','CANCELLED'))",
  }),
  target({
    table: "customer_order_bales_history",
    arabicColumn: "bale_name_ar",
    englishColumn: "bale_name",
    companyExpression: "(SELECT o.company_id FROM customer_orders o WHERE o.id=t.order_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression: "true",
  }),
  target({
    table: "customer_order_expected_lines",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "t.company_id",
    articleCodeExpression: "t.article_code",
    finalizedExpression:
      "EXISTS (SELECT 1 FROM customer_orders o WHERE o.id=t.order_id AND o.status IN ('FINALIZED','INVOICED','COMPLETED','CANCELLED'))",
  }),
  target({
    table: "factory_pos_sale_items",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT s.company_id FROM factory_pos_sales s WHERE s.id=t.sale_id)",
    productIdExpression: "t.product_id",
    articleCodeExpression: "t.article_code",
    finalizedExpression: "true",
  }),
  target({
    table: "customer_order_bale_removals",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT o.company_id FROM customer_orders o WHERE o.id=t.order_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression: "true",
  }),
  target({
    table: "factory_v3_load_bales",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT l.company_id FROM factory_v3_loads l WHERE l.id=t.load_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression: "false",
  }),
  target({
    table: "factory_invoice_loading_bales",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT l.company_id FROM factory_invoice_loadings l WHERE l.id=t.loading_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression: "false",
  }),
  target({
    table: "customer_dispatch_bale_scans",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT d.company_id FROM customer_dispatch_batches d WHERE d.id=t.batch_id)",
    productIdExpression: "(SELECT b.product_id FROM factory_bales b WHERE b.id=t.bale_id)",
    articleCodeExpression: "COALESCE(t.article_code,(SELECT b.article_code FROM factory_bales b WHERE b.id=t.bale_id))",
    finalizedExpression: "false",
  }),
  target({
    table: "bale_recode_items",
    arabicColumn: "product_name_ar",
    englishColumn: "product_name",
    companyExpression: "(SELECT s.company_id FROM bale_recode_sessions s WHERE s.id=t.session_id)",
    productIdExpression: "t.product_id",
    articleCodeExpression: "t.article_code",
    finalizedExpression: "true",
  }),
];

function assertIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function referencedTables(item: FactoryBilingualSnapshotTarget): string[] {
  const relations = new Set<string>([item.table, "factory_bale_products", "factory_categories"]);
  const expressions = [
    item.companyExpression,
    item.productIdExpression,
    item.articleCodeExpression,
    item.finalizedExpression ?? "",
  ];

  for (const expression of expressions) {
    SQL_RELATION_REFERENCE.lastIndex = 0;
    for (let match = SQL_RELATION_REFERENCE.exec(expression); match; match = SQL_RELATION_REFERENCE.exec(expression)) {
      relations.add(assertIdentifier(match[1]));
    }
  }

  return [...relations];
}

type SnapshotSchemaAvailability = Map<string, Set<string>>;
let snapshotSchemaAvailabilityPromise: Promise<SnapshotSchemaAvailability> | null = null;

/**
 * The old runtime check issued one information_schema query plus one to_regclass
 * query for every dependency of every target. A single write could therefore do
 * 60-80 schema-probe queries before touching business rows. The schema is stable
 * for the lifetime of a server process, so load all relevant table/column names
 * once and reuse the in-memory capability map until restart/deploy.
 */
async function loadSnapshotSchemaAvailability(executor: typeof db = db): Promise<SnapshotSchemaAvailability> {
  if (snapshotSchemaAvailabilityPromise) return snapshotSchemaAvailabilityPromise;

  const tableNames = new Set<string>();
  for (const item of FACTORY_BILINGUAL_SNAPSHOT_TARGETS) {
    for (const relation of referencedTables(item)) tableNames.add(assertIdentifier(relation));
  }
  const tableList = [...tableNames]
    .sort()
    .map((name) => `'${name}'`)
    .join(",");

  snapshotSchemaAvailabilityPromise = executor
    .execute(
      sql.raw(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (${tableList})
      `)
    )
    .then((result) => {
      const availability: SnapshotSchemaAvailability = new Map();
      for (const row of result.rows as Array<{ table_name?: string; column_name?: string }>) {
        if (!row.table_name || !row.column_name) continue;
        const columns = availability.get(row.table_name) ?? new Set<string>();
        columns.add(row.column_name);
        availability.set(row.table_name, columns);
      }
      return availability;
    })
    .catch((error) => {
      snapshotSchemaAvailabilityPromise = null;
      throw error;
    });

  return snapshotSchemaAvailabilityPromise;
}

async function targetExists(item: FactoryBilingualSnapshotTarget, executor: typeof db = db): Promise<boolean> {
  try {
    const availability = await loadSnapshotSchemaAvailability(executor);
    if (!availability.get(item.table)?.has(item.arabicColumn)) return false;
    return referencedTables(item).every((relation) => availability.has(relation));
  } catch (error) {
    console.error("Factory bilingual schema check failed", {
      table: item.table,
      arabicColumn: item.arabicColumn,
      dependencies: referencedTables(item),
      error,
    });
    return false;
  }
}

function resolverSql(item: FactoryBilingualSnapshotTarget): string {
  const productId = item.productIdExpression;
  const articleCode = item.articleCodeExpression;
  return `
    SELECT p.id, p.name_ar, c.name_ar AS category_name_ar
    FROM factory_bale_products p
    LEFT JOIN factory_categories c
      ON c.id=p.category_id AND c.company_id=p.company_id AND c.deleted_at IS NULL
    WHERE p.company_id=(${item.companyExpression})
      AND p.deleted_at IS NULL
      AND (
        ((${productId}) IS NOT NULL AND p.id=(${productId}))
        OR ((${productId}) IS NULL AND (${articleCode}) IS NOT NULL
          AND UPPER(BTRIM(p.article_code))=UPPER(BTRIM((${articleCode})::text)))
      )
    ORDER BY CASE WHEN p.id=(${productId}) THEN 0 ELSE 1 END
    LIMIT 1
  `;
}

function scalarResolver(item: FactoryBilingualSnapshotTarget, column: "name_ar" | "category_name_ar" | "id"): string {
  return `(SELECT r.${column} FROM LATERAL (${resolverSql(item)}) r)`;
}

function positiveScopeId(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function hasTargetScope(scope: FactoryBilingualSnapshotScope | undefined): boolean {
  if (!scope) return false;
  return Object.values(scope).some((value) => positiveScopeId(value) !== null);
}

function targetScopeGuard(
  item: FactoryBilingualSnapshotTarget,
  scope: FactoryBilingualSnapshotScope | undefined
): string | null {
  if (!scope) return "true";

  // A single successful bale scan changes exactly one order-bale row and
  // one recalculated order-line row. Prefer those exact ids over the generic
  // order scope so the synchronous response middleware does not re-scan every
  // linked order snapshot after each physical scan.
  const orderBaleId = positiveScopeId(scope.orderBaleId);
  if (orderBaleId && item.table === "customer_order_bales") return `t.id=${orderBaleId}`;

  const orderLineId = positiveScopeId(scope.orderLineId);
  if (orderLineId && item.table === "customer_order_lines") return `t.id=${orderLineId}`;

  // When exact scan ids are present, all unrelated order snapshot targets must
  // be skipped. The scope is intentionally narrow: history/removal/expected
  // rows are not changed by adding one bale to a loading.
  if (orderBaleId || orderLineId) return null;

  const orderId = positiveScopeId(scope.orderId);
  if (
    orderId &&
    [
      "customer_order_lines",
      "customer_order_bales",
      "customer_order_bales_history",
      "customer_order_expected_lines",
      "customer_order_bale_removals",
    ].includes(item.table)
  ) {
    return `t.order_id=${orderId}`;
  }

  const proformaId = positiveScopeId(scope.proformaId);
  if (proformaId && item.table === "customer_proforma_lines") return `t.proforma_id=${proformaId}`;

  const baleId = positiveScopeId(scope.baleId);
  if (baleId && item.table === "factory_bales") return `t.id=${baleId}`;

  const posSaleId = positiveScopeId(scope.posSaleId);
  if (posSaleId && item.table === "factory_pos_sale_items") return `t.sale_id=${posSaleId}`;

  const v3LoadId = positiveScopeId(scope.v3LoadId);
  if (v3LoadId && item.table === "factory_v3_load_bales") return `t.load_id=${v3LoadId}`;

  const invoiceLoadingId = positiveScopeId(scope.invoiceLoadingId);
  if (invoiceLoadingId && item.table === "factory_invoice_loading_bales") return `t.loading_id=${invoiceLoadingId}`;

  const dispatchBatchId = positiveScopeId(scope.dispatchBatchId);
  if (dispatchBatchId && item.table === "customer_dispatch_bale_scans") return `t.batch_id=${dispatchBatchId}`;

  const recodeSessionId = positiveScopeId(scope.recodeSessionId);
  if (recodeSessionId && item.table === "bale_recode_items") return `t.session_id=${recodeSessionId}`;

  return null;
}

export async function buildFactoryBilingualSnapshotPlan(
  companyId: number,
  executor: typeof db = db
): Promise<FactoryBilingualSnapshotPlan> {
  const targets: FactoryBilingualSnapshotPlanRow[] = [];
  for (const item of FACTORY_BILINGUAL_SNAPSHOT_TARGETS) {
    if (!(await targetExists(item, executor))) continue;
    const table = assertIdentifier(item.table);
    const ar = assertIdentifier(item.arabicColumn);
    const finalized = item.finalizedExpression ?? "false";
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(t.${ar}), '') IS NULL)::int AS missing,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(t.${ar}), '') IS NULL AND r.id IS NOT NULL AND NULLIF(BTRIM(r.name_ar), '') IS NOT NULL)::int AS resolvable,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(t.${ar}), '') IS NULL AND (r.id IS NULL OR NULLIF(BTRIM(r.name_ar), '') IS NULL))::int AS orphaned,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(t.${ar}), '') IS NULL AND (${finalized}))::int AS finalized
      FROM ${table} t
      LEFT JOIN LATERAL (${resolverSql(item)}) r ON true
      WHERE (${item.companyExpression})=${Number(companyId)}
    `;
    const result = await executor.execute(sql.raw(query));
    const row = (result.rows[0] ?? {}) as Record<string, number>;
    targets.push({
      table,
      arabicColumn: ar,
      missing: Number(row.missing ?? 0),
      resolvable: Number(row.resolvable ?? 0),
      orphaned: Number(row.orphaned ?? 0),
      finalized: Number(row.finalized ?? 0),
    });
  }
  return {
    companyId,
    totals: targets.reduce(
      (sum, row) => ({
        missing: sum.missing + row.missing,
        resolvable: sum.resolvable + row.resolvable,
        orphaned: sum.orphaned + row.orphaned,
        finalized: sum.finalized + row.finalized,
      }),
      { missing: 0, resolvable: 0, orphaned: 0, finalized: 0 }
    ),
    targets,
  };
}

async function applyTargets(
  companyId: number,
  options: {
    overwrite?: boolean;
    includeFinalized?: boolean;
    productId?: number;
    scope?: FactoryBilingualSnapshotScope;
  } = {},
  executor: typeof db = db
): Promise<{ updated: number; byTable: Record<string, number> }> {
  let updated = 0;
  const byTable: Record<string, number> = {};
  const scoped = hasTargetScope(options.scope);

  for (const item of FACTORY_BILINGUAL_SNAPSHOT_TARGETS) {
    const scopeGuard = targetScopeGuard(item, options.scope);
    if (scoped && scopeGuard === null) continue;
    if (!(await targetExists(item, executor))) continue;

    const table = assertIdentifier(item.table);
    const ar = assertIdentifier(item.arabicColumn);
    const finalized = item.finalizedExpression ?? "false";
    const nameValue = scalarResolver(item, "name_ar");
    const categoryValue = scalarResolver(item, "category_name_ar");
    const resolvedId = scalarResolver(item, "id");
    const setCategory = table === "factory_bales" ? `, category_ar=${categoryValue}` : "";
    const missingGuard = options.overwrite ? "true" : `NULLIF(BTRIM(t.${ar}), '') IS NULL`;
    const finalizedGuard = options.includeFinalized ? "true" : `NOT (${finalized})`;
    const productGuard = options.productId ? `${resolvedId}=${Number(options.productId)}` : "true";
    const query = `
      UPDATE ${table} t
      SET ${ar}=${nameValue}${setCategory}
      WHERE (${item.companyExpression})=${Number(companyId)}
        AND ${missingGuard}
        AND ${finalizedGuard}
        AND ${productGuard}
        AND ${scopeGuard ?? "true"}
        AND NULLIF(BTRIM(${nameValue}), '') IS NOT NULL
    `;
    const result = await executor.execute(sql.raw(query));
    const count = Number(result.rowCount ?? 0);
    byTable[table] = count;
    updated += count;
  }
  return { updated, byTable };
}

export function applyFactoryBilingualSnapshotBackfill(
  companyId: number,
  options: { overwrite?: boolean; includeFinalized?: boolean } = {},
  executor: typeof db = db
) {
  return applyTargets(companyId, options, executor);
}

export function applyFactoryBilingualSnapshotBackfillForScope(
  companyId: number,
  scope: FactoryBilingualSnapshotScope,
  executor: typeof db = db
) {
  return applyTargets(companyId, { overwrite: false, includeFinalized: false, scope }, executor);
}

export function propagateFactoryArabicCatalogChange(companyId: number, productId: number, executor: typeof db = db) {
  return applyTargets(companyId, { overwrite: true, includeFinalized: false, productId }, executor);
}
