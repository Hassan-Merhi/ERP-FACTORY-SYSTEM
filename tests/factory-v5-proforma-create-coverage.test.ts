import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const CREATE = "/api/factory/v5/proforma-with-loading";
const addContainers = (proformaId: number | string) => `/api/factory/v5/proforma/${proformaId}/add-containers`;

async function seedCatalog(w: FactoryWorld) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Proforma Customer') RETURNING id`,
    [w.companyId, `${w.tag}PC`]
  );
  await w.q(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, selling_price)
     VALUES ($1, $2, 'Agreed Item', 'ART-AG', 30), ($1, $3, 'Catalog Item', 'ART-CAT', 45), ($1, $4, 'Free Item', 'ART-FREE', 0)`,
    [w.companyId, `${w.tag}AG`, `${w.tag}CAT`, `${w.tag}FREE`]
  );
  await w.q(
    `INSERT INTO customer_destination_price_lists (company_id, customer_id, destination, article_code, price_per_bale)
     VALUES ($1, $2, 'L''SHI', 'art-ag', 55)`,
    [w.companyId, customerId]
  );
  return customerId;
}

const lines = [
  { articleCode: "ART-AG", productName: "Agreed Item", quantity: "4" },
  { articleCode: "ART-CAT", productName: "Catalog Item", quantity: 2 },
  { articleCode: "ART-FREE", productName: "Free Item", quantity: 1 },
  { articleCode: "ART-MANUAL", productName: "Manual", quantity: 3, pricePerBale: "12.5", productionPricePerBale: "9" },
  {
    articleCode: "ART-KG",
    productName: "By Kilo",
    quantity: 1,
    pricingMode: "per_kg",
    pricePerBale: "0",
    pricePerKg: "1.75",
  },
  { articleCode: "", productName: "Dropped", quantity: 9 },
];

async function proformaCount(w: FactoryWorld) {
  const rows = await w.q(`SELECT COUNT(*)::int AS n FROM customer_proformas WHERE company_id = $1`, [w.companyId]);
  return rows[0].n as number;
}

describe("V5 proforma with loading", () => {
  it("validates destination, required fields and usable lines before writing", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await seedCatalog(w);
      const post = (body: Record<string, unknown>) => w.agent.post(CREATE).send(body);
      expect((await post({ customerId, name: "P", lines })).body.message).toMatch(/destination is required/);
      expect((await post({ customerId, name: "P", destination: "x".repeat(121), lines })).status).toBe(400);
      expect((await post({ customerId, destination: "Mali", lines })).body.message).toMatch(/customerId, name/);
      expect((await post({ customerId, name: "P", destination: "Mali", lines: [] })).status).toBe(400);
      const unusable = await post({
        customerId,
        name: "P",
        destination: "Mali",
        lines: [{ articleCode: "A", productName: "B", quantity: 0 }],
      });
      expect(unusable.body.message).toMatch(/at least one line must have/i);
      expect(await proformaCount(w)).toBe(0);
    });
  });

  it("prices lines from supplied, agreed-destination and catalogue prices and opens loadings per container", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await seedCatalog(w);
      const res = await w.agent.post(CREATE).send({
        customerId,
        name: "Spring order",
        destination: " lubumbashi ",
        isActive: true,
        lines,
        sendToLoading: true,
        containerNames: ["CONT-1", "", "CONT-2"],
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body.proforma).toMatchObject({ name: "Spring order", destination: "L'SHI", isActive: true });
      const priced = Object.fromEntries(
        res.body.lines.map((line: { articleCode: string; pricePerBale: string }) => [
          line.articleCode,
          Number(line.pricePerBale),
        ])
      );
      expect(priced).toEqual({ "ART-AG": 55, "ART-CAT": 45, "ART-FREE": 0, "ART-MANUAL": 12.5, "ART-KG": 0 });
      const kilo = res.body.lines.find((line: { articleCode: string }) => line.articleCode === "ART-KG");
      expect(kilo).toMatchObject({ pricingMode: "per_kg" });
      expect(Number(kilo.pricePerKg)).toBe(1.75);
      expect(
        res.body.orders.map((order: { containerNumber: string; status: string }) => [
          order.containerNumber,
          order.status,
        ])
      ).toEqual([
        ["CONT-1", "DRAFT"],
        ["CONT-2", "DRAFT"],
      ]);
      const expected = await w.q(
        `SELECT COUNT(*)::int AS n FROM customer_order_expected_lines WHERE proforma_id = $1`,
        [res.body.proforma.id]
      );
      expect(expected[0].n).toBe(10);
    });
  });

  it("creates an inactive proforma without loadings when not sent to loading", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await seedCatalog(w);
      const res = await w.agent
        .post(CREATE)
        .send({ customerId, name: "Quote", destination: "Mali 53", lines: lines.slice(0, 1), containerNames: ["C"] });
      expect(res.status).toBe(200);
      expect(res.body.proforma).toMatchObject({ isActive: false, destination: "MALI" });
      expect(res.body.orders).toEqual([]);
      // No agreed price for MALI: falls back to the catalogue selling price.
      expect(Number(res.body.lines[0].pricePerBale)).toBe(30);
    });
  });

  it("rolls back and reports a database failure", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent
        .post(CREATE)
        .send({ customerId: 2_000_000_000, name: "Ghost", destination: "Mali", lines: lines.slice(0, 1) });
      expect(res.status).toBe(400);
      expect(await proformaCount(w)).toBe(0);
    });
  });
});

describe("V5 add containers to a proforma", () => {
  async function activeProforma(w: FactoryWorld, isActive = true, customerId?: number) {
    customerId ??= await seedCatalog(w);
    const res = await w.agent.post(CREATE).send({
      customerId,
      name: "Base",
      destination: "Mali",
      isActive,
      lines: lines.slice(0, 2),
      sendToLoading: true,
      containerNames: [isActive ? "EXIST-1" : "EXIST-2"],
    });
    expect(res.status).toBe(200);
    return Number(res.body.proforma.id);
  }

  it("validates the request and proforma state", async () => {
    await withFactoryWorld(async (w) => {
      const proformaId = await activeProforma(w);
      const add = (id: number | string, containerNames: unknown) =>
        w.agent.post(addContainers(id)).send({ containerNames });
      expect((await add("abc", ["X"])).body.message).toBe("Invalid proformaId");
      expect((await add(proformaId, [])).body.message).toMatch(/non-empty array/);
      expect((await add(proformaId, ["X", "  "])).body.message).toMatch(/must not be empty/);
      expect((await add(proformaId, ["X", "Y", "X"])).body.message).toBe("Duplicate container names in request: X");
      expect((await add(proformaId + 100000, ["X"])).status).toBe(404);
      expect((await add(proformaId, [" EXIST-1 "])).body.message).toMatch(/already exist under this proforma: EXIST-1/);

      const [{ customer_id: customerId }] = await w.q(`SELECT customer_id FROM customer_proformas WHERE id = $1`, [
        proformaId,
      ]);
      const inactiveId = await activeProforma(w, false, customerId);
      expect((await add(inactiveId, ["Z"])).body.message).toBe("Proforma is not active");
    });
  });

  it("adds DRAFT loadings with one expected line per proforma line", async () => {
    await withFactoryWorld(async (w) => {
      const proformaId = await activeProforma(w);
      const res = await w.agent.post(addContainers(proformaId)).send({ containerNames: ["NEW-1", "NEW-2"] });
      expect(res.status, res.text).toBe(200);
      expect(res.body.added).toBe(2);
      expect(res.body.expectedLinesCreated).toBe(4);
      const orders = await w.q(
        `SELECT container_number FROM customer_orders WHERE proforma_id_used = $1 ORDER BY container_number`,
        [proformaId]
      );
      expect(orders.map((order) => order.container_number)).toEqual(["EXIST-1", "NEW-1", "NEW-2"]);
    });
  });
});
