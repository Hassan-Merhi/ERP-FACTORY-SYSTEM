import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { and, desc, eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import * as schema from "../shared/schema";
import { ARABIC_TRANSLATION_TEMPLATE_HEADERS } from "../server/services/factoryArabicTranslationWorkbook";
import { isXlsxCellLocked } from "./helpers/xlsxProtection";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "xlsexp";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let categoryId: number;
let productId: number;
let otherCompanyId: number;
let otherCategoryId: number;
let otherProductId: number;

async function login(): Promise<void> {
  const loginResponse = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(loginResponse.status).toBe(200);

  const companyResponse = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(companyResponse.status).toBe(200);
}

async function createWorkbook(
  rows: Array<{
    articleCode: string;
    productNameAr?: string;
    categoryNameAr?: string;
    descriptionAr?: string;
  }>
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Arabic Names");
  sheet.addRow([...ARABIC_TRANSLATION_TEMPLATE_HEADERS]);
  for (const row of rows) {
    const excelRow = sheet.addRow([
      row.articleCode,
      "Reference English Name",
      row.productNameAr ?? "",
      "Reference English Category",
      row.categoryNameAr ?? "",
      row.descriptionAr ?? "",
      "Missing Arabic",
    ]);
    excelRow.getCell(1).numFmt = "@";
    excelRow.getCell(1).value = row.articleCode;
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function previewWorkbook(
  workbook: Buffer,
  mode: "fill-missing" | "replace-existing" = "replace-existing",
  fileName = "translations.xlsx"
) {
  return agent
    .post("/api/factory/bale-products/arabic-import/preview")
    .field("mode", mode)
    .attach("file", workbook, { filename: fileName, contentType: XLSX_MIME });
}

async function applyWorkbook(input: {
  workbook: Buffer;
  previewToken?: string;
  mode?: "fill-missing" | "replace-existing";
  fileName?: string;
}) {
  const requestBuilder = agent
    .post("/api/factory/bale-products/arabic-import/apply")
    .field("mode", input.mode ?? "replace-existing");
  if (input.previewToken) requestBuilder.field("previewToken", input.previewToken);
  return requestBuilder.attach("file", input.workbook, {
    filename: input.fileName ?? "translations.xlsx",
    contentType: XLSX_MIME,
  });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await login();

  const [category] = await db
    .insert(schema.factoryCategories)
    .values({ companyId: ctx.companyId, name: "ROUTE TEST BAGS", nameAr: null })
    .returning();
  categoryId = category.id;

  const [product] = await db
    .insert(schema.factoryBaleProducts)
    .values({
      companyId: ctx.companyId,
      code: "AR-ROUTE-001",
      articleCode: "000-AR-001",
      name: "ROUTE TEST PRODUCT",
      nameAr: null,
      description: "English route description",
      descriptionAr: null,
      categoryId,
      productionPrice: "12.34",
      sellingPrice: "56.78",
      weightPerBaleKg: "100.000",
    })
    .returning();
  productId = product.id;

  const [otherCompany] = await db
    .insert(schema.companies)
    .values({
      code: "AROTHER",
      name: `${TEST_PREFIX}_ArabicOtherFactory`,
      companyType: "factory",
      baseCurrency: "USD",
    })
    .returning();
  otherCompanyId = otherCompany.id;

  const [otherCategory] = await db
    .insert(schema.factoryCategories)
    .values({
      companyId: otherCompanyId,
      name: "OTHER ROUTE CATEGORY",
      nameAr: null,
    })
    .returning();
  otherCategoryId = otherCategory.id;

  const [otherProduct] = await db
    .insert(schema.factoryBaleProducts)
    .values({
      companyId: otherCompanyId,
      code: "AR-OTHER-001",
      articleCode: "000-AR-001",
      name: "OTHER COMPANY PRODUCT",
      nameAr: null,
      categoryId: otherCategoryId,
    })
    .returning();
  otherProductId = otherProduct.id;
}, 90_000);

afterAll(async () => {
  await pool.query("DROP TRIGGER IF EXISTS reject_factory_arabic_audit ON audit_log");
  await pool.query("DROP FUNCTION IF EXISTS reject_factory_arabic_audit_fn() CASCADE");
  await deleteAuditLogRowsForTests(pool, "company_id = $1 AND table_name = 'factory_bale_products'", [ctx?.companyId]);
  await pool.query("DELETE FROM factory_bale_products WHERE id = ANY($1::int[])", [
    [productId, otherProductId].filter(Boolean),
  ]);
  await pool.query("DELETE FROM factory_categories WHERE id = ANY($1::int[])", [
    [categoryId, otherCategoryId].filter(Boolean),
  ]);
  if (otherCompanyId) {
    await db.delete(schema.companies).where(eq(schema.companies.id, otherCompanyId));
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("Factory Arabic translation import routes", () => {
  it("keeps authentication in front of template and import endpoints", async () => {
    const templateResponse = await request(ctx.app).get("/api/factory/bale-products/arabic-template");
    expect(templateResponse.status).toBe(401);

    const workbook = await createWorkbook([{ articleCode: "000-AR-001", productNameAr: "منتج" }]);
    const previewResponse = await request(ctx.app)
      .post("/api/factory/bale-products/arabic-import/preview")
      .field("mode", "replace-existing")
      .attach("file", workbook, {
        filename: "translations.xlsx",
        contentType: XLSX_MIME,
      });
    expect(previewResponse.status).toBe(401);
  });

  it("exports a protected company-scoped .xlsx template with article codes stored as text", async () => {
    const response = await agent.get("/api/factory/bale-products/arabic-template");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain(XLSX_MIME);
    expect(response.headers["content-disposition"]).toContain("factory-arabic-names-template.xlsx");

    const responseBuffer = response.body as Buffer;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(responseBuffer);
    const sheet = workbook.worksheets[0];
    const productRowNumber = Array.from({ length: sheet.rowCount }, (_, index) => index + 1).find(
      (rowNumber) => sheet.getRow(rowNumber).getCell(1).value === "000-AR-001"
    );
    expect(productRowNumber).toBeDefined();
    const productRow = productRowNumber ? sheet.getRow(productRowNumber) : undefined;
    expect(productRow?.getCell(1).value).toBe("000-AR-001");
    expect(productRow?.getCell(1).numFmt).toBe("@");
    await expect(isXlsxCellLocked(responseBuffer, `A${productRowNumber}`)).resolves.toBe(true);
    expect(productRow?.getCell(3).protection.locked).toBe(false);
  });

  it("requires a preview token before apply", async () => {
    const workbook = await createWorkbook([{ articleCode: "000-AR-001", productNameAr: "منتج بلا معاينة" }]);
    const response = await applyWorkbook({ workbook });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("Preview");
  });

  it("applies only Arabic fields, stays company-scoped, persists an audit, and is idempotent", async () => {
    const workbook = await createWorkbook([
      {
        articleCode: "000-ar-001",
        productNameAr: "منتج اختبار المسار",
        categoryNameAr: "حقائب اختبار المسار",
        descriptionAr: "وصف عربي للمسار",
      },
    ]);

    const preview = await previewWorkbook(workbook);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      totalRows: 1,
      matchedProducts: 1,
      rowsToApply: 1,
      productsToUpdate: 1,
      categoriesToUpdate: 1,
      blocked: false,
    });
    expect(preview.body.previewToken).toMatch(/^[a-f0-9]{64}$/);

    const applied = await applyWorkbook({
      workbook,
      previewToken: preview.body.previewToken,
    });
    expect(applied.status).toBe(200);
    expect(applied.body.changedProductIds).toEqual([productId]);
    expect(applied.body.changedCategoryIds).toEqual([categoryId]);

    const [product] = await db
      .select()
      .from(schema.factoryBaleProducts)
      .where(eq(schema.factoryBaleProducts.id, productId));
    expect(product).toMatchObject({
      articleCode: "000-AR-001",
      name: "ROUTE TEST PRODUCT",
      nameAr: "منتج اختبار المسار",
      description: "English route description",
      descriptionAr: "وصف عربي للمسار",
    });
    expect(Number(product.productionPrice)).toBeCloseTo(12.34);
    expect(Number(product.sellingPrice)).toBeCloseTo(56.78);
    expect(Number(product.weightPerBaleKg)).toBeCloseTo(100);

    const [category] = await db
      .select()
      .from(schema.factoryCategories)
      .where(eq(schema.factoryCategories.id, categoryId));
    expect(category.name).toBe("ROUTE TEST BAGS");
    expect(category.nameAr).toBe("حقائب اختبار المسار");

    const [otherProduct] = await db
      .select()
      .from(schema.factoryBaleProducts)
      .where(eq(schema.factoryBaleProducts.id, otherProductId));
    expect(otherProduct.nameAr).toBeNull();

    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.companyId, ctx.companyId),
          eq(schema.auditLog.tableName, "factory_bale_products"),
          eq(schema.auditLog.recordIdentifier, "translations.xlsx")
        )
      )
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    expect(audit).toMatchObject({
      action: "import",
      companyId: ctx.companyId,
      userId: ctx.userId,
      recordIdentifier: "translations.xlsx",
    });
    expect((audit.changes as any)?.arabicTranslationImport?.new).toMatchObject({
      mode: "replace-existing",
      changedProductIds: [productId],
      changedCategoryIds: [categoryId],
      companyId: ctx.companyId,
    });

    const idempotentPreview = await previewWorkbook(workbook);
    expect(idempotentPreview.status).toBe(200);
    expect(idempotentPreview.body).toMatchObject({
      rowsToApply: 0,
      unchangedRows: 1,
      productsToUpdate: 0,
      categoriesToUpdate: 0,
    });
    const idempotentApply = await applyWorkbook({
      workbook,
      previewToken: idempotentPreview.body.previewToken,
    });
    expect(idempotentApply.status).toBe(200);
    expect(idempotentApply.body.changedProductIds).toEqual([]);
    expect(idempotentApply.body.changedCategoryIds).toEqual([]);
  });

  it("rejects a stale preview after the catalog changes", async () => {
    const workbook = await createWorkbook([{ articleCode: "000-AR-001", productNameAr: "قيمة من معاينة قديمة" }]);
    const preview = await previewWorkbook(workbook);
    expect(preview.status).toBe(200);

    await db
      .update(schema.factoryBaleProducts)
      .set({ nameAr: "قيمة أحدث" })
      .where(eq(schema.factoryBaleProducts.id, productId));

    const response = await applyWorkbook({
      workbook,
      previewToken: preview.body.previewToken,
    });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain("changed after preview");

    const [product] = await db
      .select({ nameAr: schema.factoryBaleProducts.nameAr })
      .from(schema.factoryBaleProducts)
      .where(eq(schema.factoryBaleProducts.id, productId));
    expect(product.nameAr).toBe("قيمة أحدث");
  });

  it("blocks duplicate workbook article codes before any update", async () => {
    const workbook = await createWorkbook([
      { articleCode: "000-AR-001", productNameAr: "القيمة الأولى" },
      { articleCode: "000-ar-001", productNameAr: "القيمة الثانية" },
    ]);
    const preview = await previewWorkbook(workbook);
    expect(preview.status).toBe(200);
    expect(preview.body.blocked).toBe(true);
    expect(preview.body.duplicateArticleCodes).toEqual(["000-AR-001"]);

    const response = await applyWorkbook({
      workbook,
      previewToken: preview.body.previewToken,
    });
    expect(response.status).toBe(409);
  });

  it("rolls product and category updates back when durable audit persistence fails", async () => {
    await db
      .update(schema.factoryBaleProducts)
      .set({ nameAr: "قبل التراجع", descriptionAr: null })
      .where(eq(schema.factoryBaleProducts.id, productId));
    await db
      .update(schema.factoryCategories)
      .set({ nameAr: "فئة قبل التراجع" })
      .where(eq(schema.factoryCategories.id, categoryId));

    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_factory_arabic_audit_fn()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.table_name = 'factory_bale_products' AND NEW.record_identifier = 'rollback.xlsx' THEN
          RAISE EXCEPTION 'intentional translation audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query("DROP TRIGGER IF EXISTS reject_factory_arabic_audit ON audit_log");
    await pool.query(`
      CREATE TRIGGER reject_factory_arabic_audit
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION reject_factory_arabic_audit_fn()
    `);

    try {
      const workbook = await createWorkbook([
        {
          articleCode: "000-AR-001",
          productNameAr: "بعد التراجع لا يجب حفظها",
          categoryNameAr: "فئة بعد التراجع لا يجب حفظها",
          descriptionAr: "وصف لا يجب حفظه",
        },
      ]);
      const preview = await previewWorkbook(workbook, "replace-existing", "rollback.xlsx");
      expect(preview.status).toBe(200);

      const response = await applyWorkbook({
        workbook,
        previewToken: preview.body.previewToken,
        fileName: "rollback.xlsx",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);

      const [product] = await db
        .select({
          nameAr: schema.factoryBaleProducts.nameAr,
          descriptionAr: schema.factoryBaleProducts.descriptionAr,
        })
        .from(schema.factoryBaleProducts)
        .where(eq(schema.factoryBaleProducts.id, productId));
      const [category] = await db
        .select({ nameAr: schema.factoryCategories.nameAr })
        .from(schema.factoryCategories)
        .where(eq(schema.factoryCategories.id, categoryId));

      expect(product).toEqual({ nameAr: "قبل التراجع", descriptionAr: null });
      expect(category.nameAr).toBe("فئة قبل التراجع");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_factory_arabic_audit ON audit_log");
      await pool.query("DROP FUNCTION IF EXISTS reject_factory_arabic_audit_fn() CASCADE");
    }
  });

  it("rejects non-xlsx uploads", async () => {
    const response = await agent
      .post("/api/factory/bale-products/arabic-import/preview")
      .field("mode", "replace-existing")
      .attach("file", Buffer.from("not,xlsx"), {
        filename: "translations.csv",
        contentType: "text/csv",
      });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain(".xlsx");
  });
});
