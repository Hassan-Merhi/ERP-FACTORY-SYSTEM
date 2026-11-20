/**
 * Customer statement PDF (customers-core/statementPdfStep.ts) with a company
 * logo URL in company settings, through the real app in one rolled-back
 * transaction: the logo is fetched over http from a local server, and an
 * unreachable https logo falls back without failing the export. Also pins the
 * refusal for a non-numeric customer id.
 */
import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { statementCustomer } from "./helpers/customerStatementFixture";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
let server: http.Server;
let hits = 0;
let logoUrl = "";

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  logoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/logo.png`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function binary(res: { on: (e: string, cb: (c?: Buffer) => void) => void }, cb: (e: Error | null, b: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c) => chunks.push(c!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

async function pdf(w: FactoryWorld, id: number) {
  const res = await w.agent.get(`/api/factory/customers/${id}/statement/export-pdf`).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  const body = res.body as Buffer;
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  return body.toString("latin1");
}

const setLogo = (w: FactoryWorld, url: string) =>
  w.q(
    `INSERT INTO company_settings (company_id, logo_url) VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET logo_url = EXCLUDED.logo_url`,
    [w.companyId, url]
  );

describe("customer statement PDF logo", () => {
  it("refuses a non-numeric customer id", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.get(`/api/factory/customers/abc/statement/export-pdf`);
      expect([res.status, res.body.message]).toEqual([400, "Invalid customer ID"]);
    });
  });

  it("embeds the company logo fetched from its URL", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w);
      await setLogo(w, logoUrl);
      const before = hits;
      const doc = await pdf(w, customerId);
      expect(hits).toBe(before + 1);
      expect(doc).toMatch(/\/Subtype \/Image/);
    });
  });

  it("still renders when an https logo cannot be fetched", async () => {
    await withFactoryWorld(async (w) => {
      const { customerId } = await statementCustomer(w);
      await setLogo(w, "https://127.0.0.1:1/logo.png");
      expect(await pdf(w, customerId)).toContain("%%EOF");
    });
  });
});
