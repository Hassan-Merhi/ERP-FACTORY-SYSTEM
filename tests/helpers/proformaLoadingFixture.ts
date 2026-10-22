/**
 * Disposable proforma/loading fixture for DB-backed loading-plan tests.
 *
 * Builds one factory company with a customer, a location and helpers to add
 * proformas, loadings of each plan kind and scanned bales. Callers mock
 * `../server/auth` (so `requireAuth` passes) before importing this module's
 * route harness, and call `cleanup()` in `afterAll`.
 *
 * Plan kind is what the application derives from the loading's
 * LOADING_CREATED daybook entry:
 *   - ordinary:     "Loading started for customer: ..."
 *   - continuation: "Continuation of loading #N for ..."
 *   - snapshot:     no such entry (e.g. a V5 container allocation)
 */
import { sql } from "drizzle-orm";
import { db } from "../../server/db";

export type PlanKind = "ordinary" | "continuation" | "snapshot";

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
export type RouteResponse = { statusCode: number; body: any };

/** Minimal Express stand-in that keeps the final handler of each route. */
export function createRouteHarness(...registrars: Array<(app: any) => void>) {
  const handlers = new Map<string, Handler>();
  const record =
    (method: string) =>
    (path: string, ...chain: unknown[]) => {
      const key = `${method} ${path}`;
      if (!handlers.has(key)) handlers.set(key, chain.at(-1) as Handler);
    };
  const app = {
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  };
  for (const register of registrars) register(app);

  return async function call(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    companyId: number,
    input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}
  ): Promise<RouteResponse> {
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) throw new Error(`No handler registered for ${method} ${path}`);
    const res: any = {
      statusCode: 200,
      body: undefined,
      headers: {} as Record<string, string>,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
      set(name: string, value: string) {
        res.headers[name] = value;
        return res;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
        return res;
      },
    };
    await handler(
      {
        session: { factoryCompanyId: companyId, userId: 1, username: "proforma-fixture" },
        params: input.params ?? {},
        query: input.query ?? {},
        body: input.body ?? {},
        headers: {},
        get: () => undefined,
      },
      res
    );
    return res as RouteResponse;
  };
}

const rows = (result: unknown) => (result as { rows: Record<string, any>[] }).rows;

export async function createProformaLoadingFixture(prefix: string) {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  const one = async (query: ReturnType<typeof sql>) => Number(rows(await db.execute(query))[0]?.id);

  const companyId = await one(sql`INSERT INTO companies (code, name, company_type)
    VALUES (${prefix + suffix}, ${`${prefix} fixture ${suffix}`}, 'factory') RETURNING id`);
  const customerId = await one(sql`INSERT INTO customers (company_id, code, legal_name)
    VALUES (${companyId}, ${"C" + suffix}, 'JNAH Trading') RETURNING id`);
  const locationId = await one(sql`INSERT INTO locations (company_id, code, name)
    VALUES (${companyId}, ${"L" + suffix}, 'Loading Yard') RETURNING id`);
  let baleSeq = 0;

  /** Proforma lines; `createdAt` defaults to now(). */
  async function proforma(lines: Array<{ code: string; qty: number; name?: string; createdAt?: string }>) {
    const proformaId = await one(sql`INSERT INTO customer_proformas (company_id, customer_id, name, is_active)
      VALUES (${companyId}, ${customerId}, ${"PF-" + suffix}, true) RETURNING id`);
    for (const line of lines) {
      await db.execute(sql`INSERT INTO customer_proforma_lines
          (proforma_id, article_code, product_name, quantity, price_per_bale, created_at)
        VALUES (${proformaId}, ${line.code}, ${line.name ?? line.code}, ${line.qty}, 10,
          COALESCE(${line.createdAt ?? null}::timestamp, now()))`);
    }
    return proformaId;
  }

  /** A loading of the given plan kind with its saved expected plan. */
  async function loading(options: {
    proformaId: number;
    status: string;
    kind: PlanKind;
    expected: Array<{ code: string; qty: number }>;
    createdAt?: string;
  }) {
    const createdAt = options.createdAt ?? "2026-01-01 08:00";
    const orderId = await one(sql`INSERT INTO customer_orders
        (company_id, customer_id, order_date, status, proforma_id_used, location_id, created_at, updated_at)
      VALUES (${companyId}, ${customerId}, '2026-01-01', ${options.status}, ${options.proformaId},
        ${locationId}, ${createdAt}, ${createdAt}) RETURNING id`);
    for (const line of options.expected) {
      await db.execute(sql`INSERT INTO customer_order_expected_lines
          (company_id, order_id, proforma_id, article_code, product_name, expected_qty)
        VALUES (${companyId}, ${orderId}, ${options.proformaId}, ${line.code}, ${line.code}, ${line.qty})`);
    }
    if (options.kind !== "snapshot") {
      const description =
        options.kind === "ordinary"
          ? "Loading started for customer: JNAH Trading"
          : `Continuation of loading #${orderId - 1} for JNAH Trading`;
      await db.execute(sql`INSERT INTO factory_daybook_entries
          (company_id, tx_date, tx_type, description, reference_table, reference_id)
        VALUES (${companyId}, '2026-01-01', 'LOADING_CREATED', ${description}, 'customer_orders', ${orderId})`);
    }
    return orderId;
  }

  /** Scan `count` distinct physical bales of `code` into the loading. */
  async function scan(orderId: number, code: string, count = 1) {
    for (let i = 0; i < count; i++) {
      baleSeq += 1;
      const reference = `${code}-${suffix}-${baleSeq}`;
      const baleId = await one(sql`INSERT INTO factory_bales
          (company_id, bale_code, reference_number, weight_kg, status, article_code)
        VALUES (${companyId}, ${reference}, ${reference}, 40, 'IN_STOCK', ${code}) RETURNING id`);
      await db.execute(sql`INSERT INTO customer_order_bales
          (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
        VALUES (${orderId}, ${baleId}, ${reference}, ${locationId}, 40, 10, ${code}, ${code})`);
    }
  }

  /** Saved expected plan of a loading, keyed by stored article code. */
  async function expectedPlan(orderId: number) {
    const result = await db.execute(sql`SELECT article_code, expected_qty FROM customer_order_expected_lines
      WHERE order_id = ${orderId} ORDER BY article_code`);
    return Object.fromEntries(rows(result).map((row) => [row.article_code, Number(row.expected_qty)]));
  }

  async function cleanup() {
    const orders = sql`SELECT id FROM customer_orders WHERE company_id = ${companyId}`;
    await db.execute(sql`DELETE FROM customer_order_bales WHERE order_id IN (${orders})`);
    await db.execute(sql`DELETE FROM customer_order_lines WHERE order_id IN (${orders})`);
    for (const table of [
      "proforma_stock_reservations",
      // Proforma line routes auto-save the line price into the customer's list.
      "customer_price_lists",
      "customer_order_expected_lines",
      "factory_daybook_entries",
      "customer_orders",
      "factory_bales",
      "customer_proformas",
      "customers",
      "locations",
    ]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE company_id = ${companyId}`);
    }
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
  }

  return { companyId, customerId, locationId, proforma, loading, scan, expectedPlan, cleanup };
}
