/**
 * Fast WhatsApp send routes (server/routes/whatsappFastSendRoutes.ts) over real
 * HTTP in a rolled-back factory world: POS invoice send (input, other-company
 * voucher and location, POS shift ownership, missing location / group, dry
 * run, PDF sanity checks, provider success and failure, generator crash) and
 * the ledger statement send (input, other-company account, missing target,
 * provider success and failure). The Green API upload (sendBufferFast) is the
 * outbound boundary and is mocked; the invoice PDF generator is swapped for
 * fixed results so the sanity checks on its output can be driven.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  pdf: null as null | (() => Promise<unknown>),
}));
vi.mock("../server/routes/whatsappFastSendRoutesSendBufferFast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/routes/whatsappFastSendRoutesSendBufferFast")>()),
  sendBufferFast: (...args: unknown[]) => hoisted.send(...args),
}));
vi.mock("../server/helpers/generateInvoicePdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/helpers/generateInvoicePdf")>();
  return {
    ...real,
    generateInvoicePdfMeta: (...args: Parameters<typeof real.generateInvoicePdfMeta>) =>
      hoisted.pdf ? hoisted.pdf() : real.generateInvoicePdfMeta(...args),
  };
});

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

afterEach(() => {
  hoisted.send.mockReset();
  hoisted.pdf = null;
});

const INVOICE = "/api/pos/send-invoice-whatsapp";
const pdfBuffer = (size = 2000) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(size)]);

async function otherCompany(world: FactoryWorld) {
  const companyId = await world.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${world.tag}X`,
  ]);
  const locationId = await world.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
    [companyId, `${world.tag}XL`]
  );
  return { companyId, locationId };
}

async function salesVoucher(world: FactoryWorld, options: { locationId?: number | null; credit?: boolean } = {}) {
  const locationId = options.locationId === undefined ? world.locationId : options.locationId;
  const voucherId = await world.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, is_credit_sale)
     VALUES ($1, $2, 'Sales', '2026-05-04', '25', $3, $4) RETURNING id`,
    [world.companyId, `${world.tag}-S${Math.floor(Math.random() * 1e6)}`, locationId, options.credit ?? false]
  );
  if (options.credit) {
    const customer = await world.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Mama/Ngozi', 'Asset') RETURNING id`,
      [world.companyId, `${world.tag}-CU`]
    );
    await world.q(
      `INSERT INTO voucher_entries (company_id, voucher_id, ledger_account_id, debit_amount, credit_amount)
       VALUES ($1, $2, $3, '25', '0')`,
      [world.companyId, voucherId, customer]
    );
  }
  return voucherId;
}

const withGroup = (world: FactoryWorld) =>
  world.q(`UPDATE locations SET whatsapp_group_chat_id = '120363000000000999@g.us' WHERE id = $1`, [world.locationId]);

describe("POS invoice fast send", () => {
  it("refuses bad ids, other companies' vouchers and locations, and missing locations or groups", () =>
    withFactoryWorld(async (world) => {
      expect((await world.agent.post(INVOICE).send({})).status).toBe(400);
      expect((await world.agent.post(INVOICE).send({ voucherId: -1 })).body.message).toBe("Invalid voucherId");

      const foreign = await otherCompany(world);
      const foreignVoucher = await world.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Sales', '2026-05-04', '1') RETURNING id`,
        [foreign.companyId, `${world.tag}-FV`]
      );
      const notMine = await world.agent.post(INVOICE).send({ voucherId: foreignVoucher });
      expect(notMine.status).toBe(404);
      expect(notMine.body.message).toBe("Voucher not found");

      const noLocation = await salesVoucher(world, { locationId: null });
      expect((await world.agent.post(INVOICE).send({ voucherId: noLocation })).body.message).toBe(
        "Voucher has no location"
      );
      const voucherId = await salesVoucher(world);
      const farLocation = await world.agent.post(INVOICE).send({ voucherId, locationId: foreign.locationId });
      expect(farLocation.status).toBe(404);
      expect(farLocation.body.message).toBe("Location not found");

      const noGroup = await world.agent.post(INVOICE).send({ voucherId });
      expect(noGroup.status).toBe(400);
      expect(noGroup.body.message).toBe("No WhatsApp group configured for this location");
      expect(hoisted.send).not.toHaveBeenCalled();
    }));

  it("builds a dry-run invoice name from the credit customer and the location", () =>
    withFactoryWorld(async (world) => {
      hoisted.pdf = async () => ({ buffer: pdfBuffer(), pageCount: 1, itemCount: 1 });
      const credit = await salesVoucher(world, { credit: true });
      const res = await world.agent.post(INVOICE).send({ voucherId: credit, dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, dryRun: true, pageCount: 1, itemCount: 1 });
      expect(res.body.filename).toBe("Mama_Ngozi Invoice Yard 2026-05-04.pdf");

      const cash = await salesVoucher(world);
      const plain = await world.agent.post(INVOICE).send({ voucherId: cash, dryRun: true });
      expect(plain.body.filename).toBe("Yard Invoice 2026-05-04.pdf");
      expect(hoisted.send).not.toHaveBeenCalled();
    }));

  it("refuses broken or oversized PDFs and reports generator failures", () =>
    withFactoryWorld(async (world) => {
      await withGroup(world);
      const voucherId = await salesVoucher(world);
      for (const broken of [
        { buffer: null, pageCount: 1, itemCount: 1 },
        { buffer: Buffer.from("%PDF tiny"), pageCount: 1, itemCount: 1 },
        { buffer: Buffer.concat([Buffer.from("NOPE"), Buffer.alloc(2000)]), pageCount: 1, itemCount: 1 },
      ]) {
        hoisted.pdf = async () => broken;
        const res = await world.agent.post(INVOICE).send({ voucherId });
        expect(res.status).toBe(500);
        expect(res.body.message).toBe("PDF generation failed: invalid or empty PDF");
      }
      hoisted.pdf = async () => ({ buffer: pdfBuffer(), pageCount: 9, itemCount: 20 });
      const excessive = await world.agent.post(INVOICE).send({ voucherId });
      expect(excessive.status).toBe(500);
      expect(excessive.body.message).toContain("PDF page count (9) is excessive for 20 items");

      hoisted.pdf = async () => {
        throw new Error("renderer crashed");
      };
      const crashed = await world.agent.post(INVOICE).send({ voucherId });
      expect(crashed.status).toBe(500);
      expect(crashed.body.message).toBe("renderer crashed");
      expect(hoisted.send).not.toHaveBeenCalled();
    }));

  it("sends through the provider and maps provider failures to 502", () =>
    withFactoryWorld(async (world) => {
      await withGroup(world);
      const voucherId = await salesVoucher(world);
      hoisted.pdf = async () => ({ buffer: pdfBuffer(), pageCount: 1, itemCount: 3 });
      hoisted.send.mockResolvedValueOnce({ success: true, mode: "upload" });
      const ok = await world.agent.post("/api/pos/send-invoice-pdf-backend").send({ voucherId });
      expect(ok.body).toEqual({ success: true, deliveryMode: "upload", deliveryStatus: "accepted" });
      expect(hoisted.send.mock.calls[0][1]).toBe("120363000000000999@g.us");
      expect(hoisted.send.mock.calls[0][3]).toBe("Yard Invoice 2026-05-04.pdf");

      hoisted.send.mockResolvedValueOnce({ success: false, error: "quota exceeded", mode: "url" });
      const failed = await world.agent.post(INVOICE).send({ voucherId });
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe("quota exceeded");
      hoisted.send.mockResolvedValueOnce({ success: false, mode: "url" });
      expect((await world.agent.post(INVOICE).send({ voucherId })).body.message).toBe("WhatsApp send failed");
    }));

  it("lets a POS cashier send only invoices from their own shift", () =>
    withFactoryWorld(async (world) => {
      const cashier = await world.agentFor("POS");
      const shift = (userId: string) =>
        world.one(
          `INSERT INTO pos_shifts (company_id, location_id, user_id, username, status, opening_cash)
           VALUES ($1, $2, $3, 'owner', 'open', '0')
           RETURNING id`,
          [world.companyId, world.locationId, userId]
        );
      const voucherId = await salesVoucher(world);
      await world.q(`UPDATE vouchers SET shift_id = $1 WHERE id = $2`, [await shift(world.userId), voucherId]);
      const res = await cashier.post(INVOICE).send({ voucherId, dryRun: true });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Access denied");
    }));
});

describe("account statement fast send", () => {
  it("validates the account, its company and its WhatsApp target, then sends the month", () =>
    withFactoryWorld(async (world) => {
      const url = (id: number | string) => `/api/factory/accounts/${id}/send-statement-whatsapp`;
      expect((await world.agent.post(url("abc")).send({})).status).toBe(400);
      const foreign = await otherCompany(world);
      const foreignAccount = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Far', 'Asset') RETURNING id`,
        [foreign.companyId, `${world.tag}-FA`]
      );
      expect((await world.agent.post(url(foreignAccount)).send({})).status).toBe(404);

      const account = await world.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Hadi & Sons', 'Asset') RETURNING id`,
        [world.companyId, `${world.tag}-AC`]
      );
      const noTarget = await world.agent.post(url(account)).send({});
      expect(noTarget.status).toBe(400);
      expect(noTarget.body.message).toBe("No WhatsApp target configured for this account");

      await world.q(
        `INSERT INTO factory_account_whatsapp_rules (company_id, ledger_account_id, whatsapp_chat_id) VALUES ($1, $2, $3)`,
        [world.companyId, account, "243810000111@c.us"]
      );
      hoisted.send.mockResolvedValueOnce({ success: true, mode: "url" });
      const sent = await world.agent
        .post(`/api/accounts/${account}/send-statement-whatsapp`)
        .send({ month: "2026-04" });
      expect(sent.status).toBe(200);
      expect(sent.body).toEqual({
        success: true,
        fileName: "Hadi _ Sons Statement 2026-04.pdf",
        deliveryMode: "url",
        deliveryStatus: "accepted",
      });
      expect(hoisted.send.mock.calls[0][4]).toBe("Hadi & Sons — Statement 2026-04");

      hoisted.send.mockResolvedValueOnce({ success: false, error: "number not on WhatsApp", mode: "upload" });
      const failed = await world.agent.post(url(account)).send({});
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe("number not on WhatsApp");
      hoisted.send.mockResolvedValueOnce({ success: false, mode: "upload" });
      expect((await world.agent.post(url(account)).send({})).body.message).toBe("WhatsApp send failed");

      hoisted.send.mockRejectedValueOnce(new Error("socket hang up"));
      const crashed = await world.agent.post(url(account)).send({});
      expect(crashed.status).toBe(500);
      expect(crashed.body.message).toBe("socket hang up");
    }));
});
