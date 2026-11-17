import React from "react";
import { cleanup, waitFor } from "@testing-library/react";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { renderWithProviders } from "./helpers";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";
import LegacyVoucherEditRedirect from "@/pages/daybook/LegacyVoucherEditRedirect";

/**
 * The separate voucher edit page is retired (owner decision 5, 2026-11-16). Its old URLs in every
 * workspace look the voucher up and replace themselves with the editor Daybook's Edit opens.
 */

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});
afterEach(() => {
  cleanup();
  api.restore();
});

function renderAt(path: string) {
  const memory = memoryLocation({ path, record: true });
  renderWithProviders(
    <Router hook={memory.hook}>
      <Switch>
        <Route path="/vouchers/:id/edit" component={LegacyVoucherEditRedirect} />
        <Route path="/factory/vouchers/:id/edit" component={LegacyVoucherEditRedirect} />
        <Route path="/properties/vouchers/:id/edit" component={LegacyVoucherEditRedirect} />
        <Route>{() => <div data-testid="landed" />}</Route>
      </Switch>
    </Router>
  );
  return memory;
}

describe("retired /vouchers/:id/edit", () => {
  it("replaces an ERP link with the Daybook editor for the voucher's type", async () => {
    api.get("/api/vouchers/5", { id: 5, voucherType: "Journal" });
    const memory = renderAt("/vouchers/5/edit");
    await waitFor(() => expect(memory.history.at(-1)).toBe("/vouchers?edit=5&tab=journal&from=daybook"));
    expect(memory.history).not.toContain("/vouchers/5/edit");
  });

  it("keeps Factory and Properties links in their own workspace", async () => {
    api.get("/api/vouchers/6", { id: 6, voucherType: "Payment" });
    api.get("/api/vouchers/7", { id: 7, voucherType: "Receipt" });
    const factory = renderAt("/factory/vouchers/6/edit");
    await waitFor(() => expect(factory.history.at(-1)).toBe("/factory/vouchers?edit=6&tab=payment&from=daybook"));
    cleanup();
    const properties = renderAt("/properties/vouchers/7/edit");
    await waitFor(() => expect(properties.history.at(-1)).toBe("/properties/vouchers?edit=7&tab=receipt&from=daybook"));
  });

  it("opens the read-only voucher when the voucher cannot be loaded", async () => {
    api.get("/api/vouchers/8", respond(404, { message: "Voucher not found" }));
    const memory = renderAt("/vouchers/8/edit");
    await waitFor(() => expect(memory.history.at(-1)).toBe("/voucher-detail/8"));
  });
});
