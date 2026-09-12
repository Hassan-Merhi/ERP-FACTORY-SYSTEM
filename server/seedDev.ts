import { db } from "./db";
import { getErrorMessage } from "./lib/httpHandlers";
import { eq, and, sql } from "drizzle-orm";
import { users, baleProducts, baleLabelPrints, baleSequences, mixBatches } from "@shared/schema";

type SeedBaleRow = {
  id: number;
  quantity: number;
  pieces?: number | null;
  weight_kg: string;
  weightKg?: string | null;
};

export async function runDevSeed() {
  const COMPANY_ID = 11;
  const LOCATION_ID = 184;

  await db.execute(sql`UPDATE mix_batches SET status = 'ACTIVE' WHERE status IN ('PLANNING', 'IN_PROGRESS')`);

  const userRows = await db.select().from(users).limit(2);
  if (userRows.length < 1) {
    throw new Error("Need at least 1 user in DB");
  }
  const userId1 = userRows[0].id;
  const userId2 = userRows.length > 1 ? userRows[1].id : userRows[0].id;
  const userIds = [userId1, userId2];

  const productDefs = [
    { code: "HHR-2", articleCode: "HMD01000", name: "HOUSE HOLD RUMMAGE 2" },
    { code: "CMFRT", articleCode: "HMD02000", name: "COMFORTER" },
    { code: "MXTOW", articleCode: "HMD03000", name: "MIXED TOWELS" },
    { code: "BABY", articleCode: "HMD04000", name: "BABY CLOTHES" },
    { code: "MXJNS", articleCode: "HMD05000", name: "MIXED JEANS" },
    { code: "MXJKT", articleCode: "HMD06000", name: "MIXED JACKETS" },
    { code: "SHOES", articleCode: "HMD07000", name: "SHOES MIX" },
    { code: "CRM08", articleCode: "HMD08000", name: "CREAM" },
    { code: "BDSH", articleCode: "HMD09000", name: "BED SHEETS" },
    { code: "MXWIN", articleCode: "HMD10000", name: "MIXED WINTER" },
  ];

  const createdProducts = [];
  for (const p of productDefs) {
    const existing = await db
      .select()
      .from(baleProducts)
      .where(and(eq(baleProducts.companyId, COMPANY_ID), eq(baleProducts.articleCode, p.articleCode)))
      .limit(1);
    if (existing.length > 0) {
      createdProducts.push(existing[0]);
    } else {
      const [newP] = await db
        .insert(baleProducts)
        .values({
          companyId: COMPANY_ID,
          code: p.code,
          articleCode: p.articleCode,
          name: p.name,
          active: true,
        })
        .returning();
      createdProducts.push(newP);
    }
  }

  let activeBatches = await db
    .select()
    .from(mixBatches)
    .where(and(eq(mixBatches.companyId, COMPANY_ID), eq(mixBatches.status, "ACTIVE")));

  if (activeBatches.length === 0) {
    const [newBatch] = await db
      .insert(mixBatches)
      .values({
        companyId: COMPANY_ID,
        batchCode: "SEED-MIX-001",
        totalWeightKg: "2000.000",
        costPerKg: "1.50",
        totalCost: "3000.00",
        notes: "Seed data batch",
        status: "ACTIVE",
      })
      .returning();
    activeBatches = [newBatch];
  }
  const batchId = activeBatches[0].id;

  const seqRow = await db.select().from(baleSequences).where(eq(baleSequences.companyId, COMPANY_ID)).limit(1);
  let nextNum: number;
  if (seqRow.length > 0) {
    nextNum = seqRow[0].nextNumber;
  } else {
    await db.insert(baleSequences).values({ companyId: COMPANY_ID, nextNumber: 1 });
    nextNum = 1;
  }

  const createdBales = [];
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    const product = createdProducts[i % createdProducts.length];
    const weightKg = (Math.random() * 50 + 10).toFixed(3);
    const costPerKg = "1.50";
    const totalCost = (parseFloat(weightKg) * 1.5).toFixed(2);
    const baleNum = nextNum + i;
    const baleCode = `BL-${String(baleNum).padStart(6, "0")}`;
    const barcodeValue = `${COMPANY_ID}-${baleNum}`;
    const daysAgo = Math.floor(Math.random() * 14);
    const createdAt = new Date(now - daysAgo * 86400000);
    const pieces = Math.floor(Math.random() * 50) + 1;

    try {
      const result = await db.execute(sql`
        INSERT INTO production_bales (company_id, mix_batch_id, location_id, bale_code, barcode_value, quantity, weight_kg, cost_per_kg, total_cost, status, created_at, updated_at)
        VALUES (${COMPANY_ID}, ${batchId}, ${LOCATION_ID}, ${baleCode}, ${barcodeValue}, ${pieces}, ${weightKg}, ${costPerKg}, ${totalCost}, 'LABEL_PRINTED', ${createdAt}, ${createdAt})
        RETURNING *
      `);
      const bale = result.rows[0] as SeedBaleRow;
      createdBales.push({ ...bale, product });
    } catch (e: unknown) {
      if (getErrorMessage(e)?.includes("duplicate")) continue;
      throw e;
    }
  }

  await db
    .update(baleSequences)
    .set({ nextNumber: nextNum + 25 })
    .where(eq(baleSequences.companyId, COMPANY_ID));

  const createdLabels = [];
  const sampleRefs: string[] = [];
  const sampleArticles: string[] = [];
  let labelIdx = 0;

  for (const bale of createdBales) {
    const numPrints = labelIdx < 10 ? 2 : 1;
    for (let p = 0; p < numPrints; p++) {
      const refNum = String(100000000 + Math.floor(Math.random() * 899999999));
      const printUser = userIds[labelIdx % 2];
      const daysAgo = Math.floor(Math.random() * 14);
      const printedAt = new Date(now - daysAgo * 86400000);

      const articleCode = bale.product.articleCode || bale.product.code;
      try {
        const [lp] = await db
          .insert(baleLabelPrints)
          .values({
            companyId: COMPANY_ID,
            productionBaleId: bale.id,
            productId: bale.product.id,
            articleCode,
            referenceNumber: refNum,
            pieces: bale.quantity || bale.pieces || 1,
            approxWeightKg: bale.weight_kg || bale.weightKg || "25.000",
            printedByUserId: printUser,
            printedAt,
            scannedByUserId: labelIdx < 10 ? userIds[(labelIdx + 1) % 2] : null,
            scannedAt: labelIdx < 10 ? new Date(printedAt.getTime() + 3600000) : null,
          })
          .returning();
        createdLabels.push(lp);

        if (sampleRefs.length < 5) sampleRefs.push(refNum);
        if (sampleArticles.length < 5 && !sampleArticles.includes(articleCode)) {
          sampleArticles.push(articleCode);
        }
      } catch (e: unknown) {
        if (getErrorMessage(e)?.includes("duplicate")) continue;
        throw e;
      }
      labelIdx++;
    }
  }

  return {
    message: "Seed data created successfully",
    products: createdProducts.length,
    bales: createdBales.length,
    labelPrints: createdLabels.length,
    scannedLabels: createdLabels.filter((l) => l.scannedAt).length,
    sampleArticleCodes: sampleArticles,
    sampleReferenceNumbers: sampleRefs,
  };
}
