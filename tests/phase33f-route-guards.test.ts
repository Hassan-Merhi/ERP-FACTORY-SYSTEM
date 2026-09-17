import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  registrations: [] as Array<{
    method: string;
    path: string;
    handlers: Array<(...args: any[]) => any>;
  }>,
}));

vi.mock("multer", () => {
  const multerMock = Object.assign(
    () => ({
      single: () => (req: any, res: any, callback: (error?: any) => unknown) => callback(),
    }),
    { memoryStorage: () => ({}) }
  );
  return { default: multerMock };
});

import { registerFactoryCompanyImportRoutes } from "../server/routes/factory/docs-users/companyImportRoutes";
import { registerGitImportRoutes } from "../server/routes/git/gitImportRoutes";
import { registerStockPriceListImportRoutes } from "../server/routes/stock/stockPriceListImportRoutes";
import { registerOrderPdfRoutes } from "../server/routes/factory/customer-orders/pdf-export/order-pdf";
import { registerOrderBaleBulkImportRoutes } from "../server/routes/factory/customer-orders/bale-scanning/bulk-import";
import { registerLocationWhatsappScheduleRoutes } from "../server/routes/location/locationWhatsappScheduleRoutes";
import { registerFactoryLocationInventoryExportRoutes } from "../server/routes/factory/stock/locationInventoryExportRoutes";
import { registerWhatsAppFastSendRoutes } from "../server/routes/whatsappFastSendRoutes";
import { registerWhatsAppRoutes } from "../server/routes/whatsappRoutes";

function fakeApp() {
  const register =
    (method: string) =>
    (path: string, ...handlers: Array<(...args: any[]) => any>) => {
      harness.registrations.push({ method, path, handlers });
    };
  return {
    get: register("GET"),
    head: register("HEAD"),
    post: register("POST"),
    patch: register("PATCH"),
    put: register("PUT"),
    delete: register("DELETE"),
  } as any;
}

function responseDouble() {
  const headers = new Map<string, unknown>();
  const res: any = { statusCode: 200, body: undefined, headersSent: false };
  res.status = vi.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    res.headersSent = true;
    return res;
  });
  res.send = vi.fn((body?: unknown) => {
    res.body = body;
    res.headersSent = true;
    return res;
  });
  res.end = vi.fn((body?: unknown) => {
    res.body = body;
    res.headersSent = true;
    return res;
  });
  res.setHeader = vi.fn((name: string, value: unknown) => {
    headers.set(name.toLowerCase(), value);
    return res;
  });
  res.getHeader = vi.fn((name: string) => headers.get(name.toLowerCase()));
  res.set = vi.fn(() => res);
  res.header = vi.fn(() => res);
  res.type = vi.fn(() => res);
  res.attachment = vi.fn(() => res);
  return res;
}

async function invoke(method: string, path: string, req: any) {
  const route = harness.registrations.find((entry) => entry.method === method && entry.path === path);
  expect(route, `${method} ${path} must be registered`).toBeTruthy();
  const res = responseDouble();
  req.headers ??= {};
  req.params ??= {};
  req.query ??= {};
  req.body ??= {};
  req.session ??= {};
  req.get ??= () => undefined;
  req.protocol ??= "http";
  req.method ??= method;
  await route!.handlers.at(-1)!(req, res, () => undefined);
  await Promise.resolve();
  await Promise.resolve();
  return res;
}

describe("Phase 33F auth, import, export and integration route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.registrations.splice(0);
  });

  it("rejects invalid factory company-import payloads before any destructive import work", async () => {
    registerFactoryCompanyImportRoutes(fakeApp());

    let res = await invoke("POST", "/api/factory/import-company-data", {
      session: { currentCompanyId: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No file uploaded" });

    res = await invoke("POST", "/api/factory/import-company-data", {
      session: { currentCompanyId: 7 },
      file: { buffer: Buffer.from("not-json") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Uploaded file is not valid JSON" });

    res = await invoke("POST", "/api/factory/import-company-data", {
      session: { currentCompanyId: 7 },
      file: { buffer: Buffer.from(JSON.stringify({ sourceCompanyId: 7, tables: {} })) },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.body?.message)).toContain("Cannot import into the same company");
  });

  it("requires a file and active company for GIT container imports", async () => {
    registerGitImportRoutes(fakeApp());

    let res = await invoke("POST", "/api/git/containers/import-excel", {
      session: { currentCompanyId: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No file uploaded" });

    res = await invoke("POST", "/api/git/containers/import-excel", {
      session: {},
      file: { buffer: Buffer.from("placeholder") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("guards stock imports and grade/category workbook uploads", async () => {
    registerStockPriceListImportRoutes(fakeApp());

    let res = await invoke("POST", "/api/stock-items/import", { session: {}, body: { items: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });

    res = await invoke("POST", "/api/stock-items/import", {
      session: { currentCompanyId: 7 },
      body: { items: "wrong-shape" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Items must be an array" });

    res = await invoke("POST", "/api/stock-items/import-grade-category-template", {
      session: { currentCompanyId: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No file uploaded" });
  });

  it("fails closed for factory PDF exports and bale bulk imports without valid tenant/order input", async () => {
    const app = fakeApp();
    registerOrderPdfRoutes(app);
    registerOrderBaleBulkImportRoutes(app);

    let res = await invoke("GET", "/api/factory/customer-orders/:id/export-pdf", {
      session: {},
      params: { id: "1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });

    res = await invoke("GET", "/api/factory/customer-orders/:id/export-pdf", {
      session: { currentCompanyId: 7 },
      params: { id: "bad-id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid id" });

    res = await invoke("POST", "/api/factory/customer-orders/:id/bales/bulk-import", {
      session: { currentCompanyId: 7 },
      params: { id: "1" },
      body: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "locationId and either items or refNumbers are required" });
  });

  it("rejects malformed or unscoped location WhatsApp schedules", async () => {
    registerLocationWhatsappScheduleRoutes(fakeApp());

    let res = await invoke("GET", "/api/locations/:locationId/whatsapp-schedule", {
      session: { currentCompanyId: 7 },
      params: { locationId: "bad" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid location ID" });

    res = await invoke("PUT", "/api/locations/:locationId/whatsapp-schedule", {
      session: {},
      params: { locationId: "3" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("requires an active company for location inventory export", async () => {
    registerFactoryLocationInventoryExportRoutes(fakeApp());
    const res = await invoke("GET", "/api/factory/location-inventory/export/all", { session: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("guards fast WhatsApp attachment and account-statement endpoints", async () => {
    registerWhatsAppFastSendRoutes(fakeApp());

    let res = await invoke("GET", "/api/whatsapp/fast-file/:token", {
      params: { token: "missing-token" },
    });
    expect(res.statusCode).toBe(404);

    res = await invoke("POST", "/api/accounts/:accountId/send-statement-whatsapp", {
      session: { currentCompanyId: 7 },
      params: { accountId: "bad" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid id" });

    res = await invoke("POST", "/api/pos/send-whatsapp-pdf-upload", {
      session: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("requires company scope on WhatsApp recipient mutations", async () => {
    registerWhatsAppRoutes(fakeApp());

    let res = await invoke("GET", "/api/whatsapp/recipients", { session: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });

    res = await invoke("POST", "/api/whatsapp/recipients", {
      session: { currentCompanyId: 7 },
      body: { chatId: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "chatId is required" });
  });
});
