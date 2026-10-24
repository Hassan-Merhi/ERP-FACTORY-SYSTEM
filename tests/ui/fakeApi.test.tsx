import React from "react";
import { screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { installFakeApi, respond } from "./fakeApi";
import { buildCustomer } from "./fixtures";
import { renderWithProviders } from "./helpers";

describe("fakeApi", () => {
  it("matches the path, ignores the query string and exposes both to handlers", async () => {
    const api = installFakeApi();
    api.get("/api/customers/:id", ({ params, query }) =>
      buildCustomer({ id: Number(params.id), legalName: query.get("name") ?? "" })
    );

    const response = await fetch("/api/customers/42?name=Acme");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 42, legalName: "Acme" });
    expect(api.callsTo("GET", "/api/customers/:id")).toHaveLength(1);
  });

  it("lets a later registration override an earlier one", async () => {
    const api = installFakeApi();
    api.get("/api/stock-items", [{ id: 1 }]);
    api.get("/api/stock-items", respond(500, { message: "stock unavailable" }));

    const response = await fetch("/api/stock-items");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "stock unavailable" });
  });

  it("supports wildcard and RegExp patterns", async () => {
    const api = installFakeApi();
    api.get("/api/reports/*", { kind: "report" });
    api.get(/^\/api\/vouchers\/(?<voucherId>\d+)$/, ({ params }) => ({ voucherId: params.voucherId }));

    expect(await (await fetch("/api/reports/sales/daily")).json()).toEqual({ kind: "report" });
    expect(await (await fetch("/api/vouchers/7")).json()).toEqual({ voucherId: "7" });
  });

  it("answers unmatched requests with an empty list and records them", async () => {
    const api = installFakeApi();

    const response = await fetch("/api/nothing-registered");

    expect(await response.json()).toEqual([]);
    expect(api.unhandled.map((call) => call.path)).toEqual(["/api/nothing-registered"]);
  });

  it("answers unmatched requests 404 in strict mode", async () => {
    installFakeApi({ onUnhandled: "error" });

    const response = await fetch("/api/nothing-registered");

    expect(response.status).toBe(404);
  });

  it("serves the CSRF token and records the JSON body of a write made through apiRequest", async () => {
    const api = installFakeApi();
    api.post("/api/customers", ({ body }) => respond(201, { id: 9, ...(body as object) }));

    const response = await apiRequest("POST", "/api/customers", { legalName: "New Customer" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 9, legalName: "New Customer" });
    const [write] = api.callsTo("POST", "/api/customers");
    expect(write.body).toEqual({ legalName: "New Customer" });
    expect(write.headers.get("X-CSRF-Token")).toBe("test-csrf-token");
  });

  it("surfaces an error status through apiRequest as a thrown error", async () => {
    const api = installFakeApi();
    api.delete("/api/customers/:id", respond(409, { message: "Customer has posted vouchers" }));

    await expect(apiRequest("DELETE", "/api/customers/3")).rejects.toThrow(/Customer has posted vouchers/);
  });

  it("feeds a component's query through the app's real query function", async () => {
    const api = installFakeApi();
    api.get("/api/customers", [buildCustomer({ legalName: "Atlas Trading" })]);

    function CustomerNames() {
      const { data } = useQuery<Array<{ legalName: string }>>({
        queryKey: ["/api/customers"],
        queryFn: getQueryFn({ on401: "throw" }),
      });
      return (
        <ul>
          {data?.map((customer) => (
            <li key={customer.legalName}>{customer.legalName}</li>
          ))}
        </ul>
      );
    }

    renderWithProviders(<CustomerNames />);

    expect(await screen.findByText("Atlas Trading")).toBeInTheDocument();
    await waitFor(() => expect(api.callsTo("GET", "/api/customers")).toHaveLength(1));
  });

  it("puts the real fetch back after each test", () => {
    // Every earlier test installed a fake; the module's afterEach must have restored it.
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  });
});
