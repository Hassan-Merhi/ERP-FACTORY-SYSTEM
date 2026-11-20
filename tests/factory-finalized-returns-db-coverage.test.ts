/**
 * Finalized customer loading returns over real HTTP and a real database, one
 * rolled-back transaction per test (the existing route test mocks the
 * database). Pinned: input refusals (with Arabic / French messages), every
 * in-transaction refusal returns 409 and writes nothing, another company's
 * invoice is not found, and a clean return moves the bale back to stock and
 * records the return batch.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/finalized-sale-returns";
let seq = 0;

interface InvoiceOptions {
  status?: string;
  previousStatus?: string | null;
  balance?: { type?: string; debit?: string; credit?: string; balance?: string } | null;
  baleStatus?: string;
  baleLocation?: number;
  companyId?: number;
}

async function invoice(w: FactoryWorld, options: InvoiceOptions = {}) {
  const n = ++seq;
  const companyId = options.companyId ?? w.companyId;
  const locationId =
    companyId === w.companyId
      ? w.locationId
      : await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
          companyId,
          `${w.tag}FL${n}`,
        ]);
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Returning Customer') RETURNING id`,
    [companyId, `${w.tag}C${n}`]
  );
  const invoiceNumber = `${w.tag}-INV${n}`;
  const orderId = await w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, previous_status, location_id,
       invoice_number, container_number, grand_total, total_qty_bales, finalized_at)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5, $6, $7, 50, 2, NOW()) RETURNING id`,
    [
      companyId,
      customerId,
      options.status ?? "FINALIZED",
      options.previousStatus === undefined ? "LOADING" : options.previousStatus,
      locationId,
      invoiceNumber,
      `${w.tag}CNT${n}`,
    ]
  );
  const bales: { baleId: number; reference: string }[] = [];
  for (let index = 0; index < 2; index += 1) {
    const reference = `${w.tag}-R${n}-${index}`;
    const baleId = await w.one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, article_code, product_name,
         weight_kg, total_cost, status, erp_location_id)
       VALUES ($1, $2, $2, 'ART-A', 'Mixed Rags', 25, 4, $3, $4) RETURNING id`,
      [companyId, reference, options.baleStatus ?? "SOLD", options.baleLocation ?? locationId]
    );
    await w.one(
      `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
       VALUES ($1, $2, $3, $4, 25, 25, 'ART-A', 'Mixed Rags') RETURNING id`,
      [orderId, baleId, reference, locationId]
    );
    bales.push({ baleId, reference });
  }
  if (options.balance !== null) {
    const balance = options.balance ?? {};
    await w.q(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type,
         reference_id, description, debit_amount, credit_amount, balance)
       VALUES ($1, $2, '2026-06-01', $3, 'INVOICE', $4, 'Invoice', $5, $6, $7)`,
      [
        companyId,
        customerId,
        balance.type ?? "SALE",
        orderId,
        balance.debit ?? "50",
        balance.credit ?? "0",
        balance.balance ?? "50",
      ]
    );
  }
  return { orderId, customerId, invoiceNumber, bales, locationId };
}

async function otherCompany(w: FactoryWorld) {
  return w.one(
    `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
    [`${w.tag}X${++seq}`]
  );
}

const body = (orderId: number, baleIds: number[], extra: Record<string, unknown> = {}) => ({
  orderId,
  baleIds,
  reason: "Customer returned damaged bale",
  confirmReturn: true,
  expectedTotal: "50.00",
  ...extra,
});

async function untouched(w: FactoryWorld, orderId: number) {
  const [links] = await w.q<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM customer_order_bales WHERE order_id = $1`,
    [orderId]
  );
  const [returns] = await w.q<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM factory_finalized_sale_returns WHERE order_id = $1`,
    [orderId]
  );
  expect(links.count).toBe(2);
  expect(returns.count).toBe(0);
}

describe("finalized returns lookups", () => {
  it("searches only this company's finalized loadings and refuses foreign or unfinished invoices", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const unloaded = await invoice(w, { previousStatus: null });
      const draft = await invoice(w, { status: "LOADING" });
      const foreignCompany = await otherCompany(w);
      const foreign = await invoice(w, { companyId: foreignCompany });

      const all = await w.agent.get(`${BASE}/orders`);
      expect(all.status).toBe(200);
      expect(all.body.map((row: { id: number }) => row.id)).toEqual([own.orderId]);
      const searched = await w.agent.get(`${BASE}/orders`).query({ search: "Returning" });
      expect(searched.body.map((row: { id: number }) => row.id)).toEqual([own.orderId]);
      expect((await w.agent.get(`${BASE}/orders`).query({ search: "zzz-none" })).body).toEqual([]);

      const detail = await w.agent.get(`${BASE}/orders/${own.orderId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.blockedReason).toBeNull();
      expect(detail.body.bales.map((bale: { referenceNumber: string }) => bale.referenceNumber).sort()).toEqual(
        own.bales.map((bale) => bale.reference).sort()
      );

      const invalid = await w.agent.get(`${BASE}/orders/abc`).set("Accept-Language", "ar");
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe("الشركة أو الفاتورة غير صالحة");
      for (const id of [foreign.orderId, draft.orderId]) {
        const missing = await w.agent.get(`${BASE}/orders/${id}`).set("Accept-Language", "fr-FR");
        expect(missing.status).toBe(404);
        expect(missing.body.message).toBe("Facture finalisée introuvable");
      }
      // A finalized order that never went through loading is still readable here.
      expect((await w.agent.get(`${BASE}/orders/${unloaded.orderId}`)).status).toBe(200);
    });
  });

  it("flags an invoice that already has dispatch-trip accounting", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      await w.q(`UPDATE customer_orders SET dispatch_batch_id = 1 WHERE id = $1`, [own.orderId]);
      const detail = await w.agent.get(`${BASE}/orders/${own.orderId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.blockedReason).toMatch(/dispatch-trip accounting/);
      const refused = await w.agent.post(`${BASE}/apply`).send(body(own.orderId, [own.bales[0].baleId]));
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/Dispatch-trip financial postings/);
      await untouched(w, own.orderId);
    });
  });
});

describe("finalized returns apply refusals", () => {
  it("refuses malformed input before opening a transaction", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const bale = own.bales[0].baleId;
      const cases: Array<[Record<string, unknown>, string, string?]> = [
        [{ ...body(own.orderId, [bale]), orderId: "x" }, "Select a finalized invoice"],
        [body(own.orderId, []), "Select 1–200 valid physical bale references"],
        [{ ...body(own.orderId, [bale]), baleIds: "1" }, "Select 1–200 valid physical bale references"],
        [body(own.orderId, [bale, -1] as number[]), "Select 1–200 valid physical bale references"],
        [body(own.orderId, [bale, bale]), "تم تحديد البالة مرتين", "ar"],
        [body(own.orderId, [bale], { reason: "bad" }), "Return reason must be 5–500 characters"],
        [
          body(own.orderId, [bale], { reason: "x".repeat(501) }),
          "Le motif du retour doit comporter entre 5 et 500 caractères",
          "fr",
        ],
        [body(own.orderId, [bale], { confirmReturn: "true" }), "Confirm selected bales are physically returned"],
        [body(own.orderId, [bale], { expectedTotal: "50.001" }), "Refresh invoice before returning its bales"],
      ];
      for (const [payload, message, language] of cases) {
        const res = await w.agent
          .post(`${BASE}/apply`)
          .set("Accept-Language", language ?? "en")
          .send(payload);
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(message);
      }
      await untouched(w, own.orderId);
    });
  });

  it("refuses an invoice that is not a finalized loading, foreign, or changed", async () => {
    await withFactoryWorld(async (w) => {
      const foreign = await invoice(w, { companyId: await otherCompany(w) });
      const notLoaded = await invoice(w, { previousStatus: null });
      const draft = await invoice(w, { status: "LOADING" });
      const own = await invoice(w);
      const expectBlocked = async (payload: Record<string, unknown>, pattern: RegExp) => {
        const res = await w.agent.post(`${BASE}/apply`).send(payload);
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(pattern);
      };
      await expectBlocked(body(foreign.orderId, [foreign.bales[0].baleId]), /no longer finalized/);
      await expectBlocked(body(draft.orderId, [draft.bales[0].baleId]), /no longer finalized/);
      await expectBlocked(body(notLoaded.orderId, [notLoaded.bales[0].baleId]), /finalized container loadings only/);
      await expectBlocked(body(own.orderId, [own.bales[0].baleId], { expectedTotal: "49" }), /Invoice total changed/);
      await untouched(w, own.orderId);
    });
  });

  it("refuses an invoice with settlement history or an adjusted balance", async () => {
    await withFactoryWorld(async (w) => {
      const scenarios: Array<[InvoiceOptions, RegExp]> = [
        [{ balance: null }, /payment\/settlement history/],
        [{ balance: { type: "PAYMENT" } }, /payment\/settlement history/],
        [{ balance: { debit: "40" } }, /already adjusted or allocated/],
        [{ balance: { balance: "30" } }, /already adjusted or allocated/],
        [{ balance: { credit: "5" } }, /already adjusted or allocated/],
      ];
      for (const [options, pattern] of scenarios) {
        const target = await invoice(w, options);
        const res = await w.agent.post(`${BASE}/apply`).send(body(target.orderId, [target.bales[0].baleId]));
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(pattern);
        await untouched(w, target.orderId);
      }
    });
  });

  it("refuses bales that are not linked, already returned, double-assigned or out of place", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const other = await invoice(w);
      const expectBlocked = async (target: { orderId: number }, baleIds: number[], pattern: RegExp) => {
        const res = await w.agent.post(`${BASE}/apply`).send(body(target.orderId, baleIds));
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(pattern);
      };
      await expectBlocked(own, [other.bales[0].baleId], /no longer linked/);

      const inStock = await invoice(w, { baleStatus: "RESERVED_FOR_ORDER" });
      await expectBlocked(inStock, [inStock.bales[0].baleId], /incompatible stock status/);

      const elsewhere = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Moved') RETURNING id`,
        [w.companyId, `${w.tag}MV`]
      );
      const moved = await invoice(w, { baleLocation: elsewhere });
      await expectBlocked(moved, [moved.bales[0].baleId], /moved locations/);

      await w.one(
        `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used)
         VALUES ($1, $2, 'dup', $3, 25, 25) RETURNING id`,
        [other.orderId, own.bales[1].baleId, w.locationId]
      );
      await expectBlocked(own, [own.bales[1].baleId], /assigned to a different loading/);

      await w.q(
        `INSERT INTO factory_finalized_sale_returns
           (return_batch, company_id, order_id, customer_id, invoice_number, bale_id, bale_reference,
            original_total, revised_total, reason, returned_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 50, 25, 'earlier', 'tester')`,
        [w.companyId, own.orderId, own.customerId, own.invoiceNumber, own.bales[0].baleId, own.bales[0].reference]
      );
      await expectBlocked(own, [own.bales[0].baleId], /already has a recorded return/);
    });
  });

  it("refuses a non-Admin role", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.post(`${BASE}/apply`).send(body(own.orderId, [own.bales[0].baleId]))).status).toBe(403);
      expect((await manager.get(`${BASE}/history`)).status).toBe(403);
      await untouched(w, own.orderId);
    });
  });
});

describe("finalized returns apply", () => {
  it("returns a bale to stock, reprices the invoice and records history", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const res = await w.agent.post(`${BASE}/apply`).send(body(own.orderId, [own.bales[0].baleId]));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orderId: own.orderId, quantity: 1, originalTotal: "50.00" });
      const [bale] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [own.bales[0].baleId]);
      expect(bale.status).toBe("IN_STOCK");
      const links = await w.q(`SELECT bale_id FROM customer_order_bales WHERE order_id = $1`, [own.orderId]);
      expect(links.map((row) => Number(row.bale_id))).toEqual([own.bales[1].baleId]);
      const history = await w.agent.get(`${BASE}/history`);
      expect(history.status).toBe(200);
      expect(history.body).toEqual([
        expect.objectContaining({ orderId: own.orderId, quantity: 1, baleReferences: own.bales[0].reference }),
      ]);
    });
  });
});

describe("finalized returns per-kg proforma drift and foreign bales", () => {
  async function perKgInvoice(w: FactoryWorld, proformaRate: string | null) {
    const own = await invoice(w);
    const proformaId = await w.one(
      `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
      [w.companyId, own.customerId, `${w.tag}-PF${++seq}`]
    );
    if (proformaRate !== null) {
      await w.q(
        `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale, pricing_mode, price_per_kg)
         VALUES ($1, 'art-a', 'Mixed Rags', 2, 25, 'per_kg', $2)`,
        [proformaId, proformaRate]
      );
    }
    await w.q(
      `INSERT INTO customer_order_lines (order_id, article_code, bale_name, qty, weight_per_bale, total_weight,
         price_per_bale, total_price, pricing_mode, price_per_kg)
       VALUES ($1, 'ART-A', 'Mixed Rags', 2, 25, 50, 25, 50, 'per_kg', 1)`,
      [own.orderId]
    );
    await w.q(`UPDATE customer_orders SET proforma_id_used = $2 WHERE id = $1`, [own.orderId, proformaId]);
    return own;
  }

  it("refuses when the proforma's per-kg rate changed or its line is gone", async () => {
    await withFactoryWorld(async (w) => {
      for (const rate of ["1.5", null]) {
        const own = await perKgInvoice(w, rate);
        const res = await w.agent.post(`${BASE}/apply`).send(body(own.orderId, [own.bales[0].baleId]));
        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/per-kg rate changed after invoicing/);
        await untouched(w, own.orderId);
      }
    });
  });

  it("passes the drift check when the proforma still carries the invoiced rate", async () => {
    await withFactoryWorld(async (w) => {
      const own = await perKgInvoice(w, "1");
      const res = await w.agent.post(`${BASE}/apply`).send(body(own.orderId, [own.bales[0].baleId]));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orderId: own.orderId, quantity: 1, originalTotal: "50.00" });
    });
  });

  it("refuses a linked bale that belongs to another company", async () => {
    await withFactoryWorld(async (w) => {
      const own = await invoice(w);
      const foreign = await invoice(w, { companyId: await otherCompany(w) });
      await w.q(`UPDATE customer_order_bales SET order_id = $1 WHERE bale_id = $2`, [
        own.orderId,
        foreign.bales[0].baleId,
      ]);
      const res = await w.agent.post(`${BASE}/apply`).send(body(own.orderId, [foreign.bales[0].baleId]));
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("Physical bale not found");
      const [bale] = await w.q(`SELECT status FROM factory_bales WHERE id = $1`, [foreign.bales[0].baleId]);
      expect(bale.status).toBe("SOLD");
    });
  });
});
