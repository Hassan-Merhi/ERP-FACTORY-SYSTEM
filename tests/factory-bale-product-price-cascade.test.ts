import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  existing: {
    id: 7,
    companyId: 3,
    name: "Jogging Pants",
    articleCode: null as string | null,
    categoryId: null as number | null,
    labelDesignColor: null as string | null,
    weightPerBaleKg: "45.00",
    productionPrice: null as string | null,
    sellingPrice: null as string | null,
  },
  writes: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: async () => [harness.existing] }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          harness.writes.push({ table, values });
          return {
            returning: async () => [{ ...harness.existing, ...values }],
            rowCount: 5,
          };
        },
      }),
    }),
  },
}));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: Error) => error.message,
}));
vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
  and: (...clauses: unknown[]) => clauses,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  factoryBaleProducts: {
    id: "product.id",
    companyId: "product.companyId",
    articleCode: "product.articleCode",
    name: "product.name",
    code: "product.code",
  },
  factoryBales: { productId: "bale.productId", companyId: "bale.companyId" },
}));

import { registerFactoryProductCascadeRoutes } from "../server/routes/factory/products/productCascadeRoutes";

type Handler = (req: any, res: any) => Promise<unknown>;
const routes = new Map<string, Handler>();
registerFactoryProductCascadeRoutes({
  post: (path: string, ...handlers: Handler[]) => routes.set(path, handlers.at(-1)!),
} as any);

function invoke(body: unknown, role = "Worker") {
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  const req = {
    params: { id: "7" },
    session: { factoryCompanyId: 3 },
    user: { role },
    body,
  };
  return routes.get("/api/factory/bale-products/:id/cascade-update")!(req, res).then(() => res);
}

describe("Factory Bale Explorer price cascade", () => {
  beforeEach(() => {
    harness.writes.length = 0;
    harness.existing.productionPrice = null;
    harness.existing.sellingPrice = null;
  });

  it("accepts a cost-price-only edit on a product with nullable catalog fields", async () => {
    const response = await invoke({ productionPrice: "89.25" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ balesUpdated: 0, product: { productionPrice: "89.25" } });
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0].values).toMatchObject({ productionPrice: "89.25" });
    expect(harness.writes[0].values).not.toHaveProperty("weightPerBaleKg");
  });

  it("does not change bale weights or reject unchanged null color in legacy full edit requests", async () => {
    const response = await invoke({
      name: "Jogging Pants",
      articleCode: null,
      weightPerBaleKg: 45,
      categoryId: null,
      labelDesignColor: null,
      productionPrice: "25",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.balesUpdated).toBe(0);
    expect(harness.writes).toHaveLength(1);
  });

  it("reports a validation error instead of throwing when the incoming name is null", async () => {
    const response = await invoke({ name: null, productionPrice: "23" });
    expect(response.statusCode).toBe(400);
    expect(response.body.message).toMatch(/product name/i);
    expect(harness.writes).toHaveLength(0);
  });

  it("does not overwrite a price with a malformed value", async () => {
    const response = await invoke({ productionPrice: "not-a-price" });
    expect(response.statusCode).toBe(400);
    expect(harness.writes).toHaveLength(0);
  });
});
