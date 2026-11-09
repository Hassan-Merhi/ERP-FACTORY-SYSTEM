/**
 * The convergence report is reachable, and only by who may read it.
 *
 * The reconciler shipped as an endpoint with no route pointing at it, which is
 * the same as not shipping it: nobody runs curl against their own books. This
 * mounts the real route table and asserts the page is served at its path.
 *
 * It also asserts the gate matches the endpoint's own. The route answers to
 * requireRole("Admin", "Owner") — Developer passes through requireRole
 * unconditionally — so a client gate any wider would advertise a page in the
 * command palette that answers 403 to everyone who found it, and a gate any
 * narrower would hide a report from someone the server is happy to serve.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// The route table is normally inside CompanyProvider; this isolated
// role-gate test supplies the same selected-company identity.
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: 7, companyType: "erp" } }),
}));

import { ErpRoutes } from "./ErpRoutes";

function renderAt(path: string, role: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Full ERP page access, so nothing below is a per-page permission
        // redirect masquerading as the role gate under test.
        queryFn: async ({ queryKey }) =>
          queryKey[0] === "/api/my-erp-pages"
            ? { fullAccess: true, pageKeys: [] }
            : { companyId: 7, accountingSnapshots: 0, stockSnapshots: 0, discrepancies: [], clean: true },
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={memoryLocation({ path, static: true }).hook}>
        <Suspense fallback={<div data-testid="route-loading" />}>
          <ErpRoutes user={{ role }} />
        </Suspense>
      </Router>
    </QueryClientProvider>
  );
}

describe("convergence reconciliation route", () => {
  it("serves the report to an Admin", async () => {
    renderAt("/convergence-reconciliation", "Admin");
    expect(await screen.findByTestId("page-convergence-reconciliation")).toBeInTheDocument();
  });

  it("serves the report to an Owner, as the endpoint does", async () => {
    renderAt("/convergence-reconciliation", "Owner");
    expect(await screen.findByTestId("page-convergence-reconciliation")).toBeInTheDocument();
  });

  it("does not serve the report to a role the endpoint would refuse", async () => {
    renderAt("/convergence-reconciliation", "Manager");

    // The lazy chunk resolves on the same microtask queue as the assertion
    // above, so a rendered page would have been found by now.
    await expect(screen.findByTestId("page-convergence-reconciliation", {}, { timeout: 250 })).rejects.toThrow();
  });
});
