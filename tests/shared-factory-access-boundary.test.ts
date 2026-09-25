import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { resolveSharedFactoryRequirements } from "../server/middleware/sharedFactoryAccessBoundary";

function req(path: string, method = "GET", body: Record<string, unknown> = {}): Request {
  return {
    path,
    method,
    originalUrl: path,
    body,
    query: {},
    session: {},
  } as unknown as Request;
}

describe("Wave 4 shared Factory API ownership", () => {
  it("allows account APIs only through owning Factory surfaces", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/all"))).toEqual(
      expect.arrayContaining([
        { pageKey: "factory/accounts", tabKey: "hide_tab_accounts_view" },
        { pageKey: "factory/vouchers" },
      ])
    );
  });

  it("allows Agent Ledger to read only the account catalog and statement endpoints it owns", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/all"))).toEqual(
      expect.arrayContaining([{ pageKey: "factory/agents" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/customer/42/transactions"))).toEqual(
      expect.arrayContaining([{ pageKey: "factory/agents" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/customer/42/pre-period-balance"))).toEqual(
      expect.arrayContaining([{ pageKey: "factory/agents" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/customer/42/transactions", "POST"))).not.toEqual(
      expect.arrayContaining([{ pageKey: "factory/agents" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/accounts/voucher-sidebar"))).not.toEqual(
      expect.arrayContaining([{ pageKey: "factory/agents" }])
    );
  });

  it("allows Invoicing to read ledger and bank pickers without granting account writes", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/ledger-accounts?profile=picker"))).toEqual(
      expect.arrayContaining([{ pageKey: "factory/invoicing" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/bank-accounts"))).toEqual(
      expect.arrayContaining([{ pageKey: "factory/invoicing" }])
    );
    expect(await resolveSharedFactoryRequirements(req("/api/ledger-accounts", "POST"))).not.toEqual(
      expect.arrayContaining([{ pageKey: "factory/invoicing" }])
    );
  });

  it("keeps voucher search tied to Find Voucher or Vouchers", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/vouchers/search"))).toEqual([
      { pageKey: "factory/accounts", tabKey: "hide_tab_accounts_find_voucher" },
      { pageKey: "factory/vouchers" },
    ]);
  });

  it("keeps account-view voucher details available without Find Voucher", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/vouchers/12/view-entries"))).toEqual(
      expect.arrayContaining([
        { pageKey: "factory/accounts", tabKey: "hide_tab_accounts_view" },
        { pageKey: "factory/accounts", tabKey: "hide_tab_accounts_find_voucher" },
      ])
    );
  });

  it("maps payment and receipt writes to their exact Factory tabs", async () => {
    expect(
      await resolveSharedFactoryRequirements(req("/api/vouchers/payment-receipt", "POST", { voucherType: "Payment" }))
    ).toEqual([{ pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_payment" }]);

    expect(
      await resolveSharedFactoryRequirements(req("/api/vouchers/payment-receipt", "POST", { voucherType: "Receipt" }))
    ).toEqual([{ pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_receipt" }]);
  });

  it("maps journal, adjustment and credit-note writes to exact tabs", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/vouchers/journal", "POST"))).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_journal" },
    ]);
    expect(await resolveSharedFactoryRequirements(req("/api/stock-adjustments", "POST"))).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_adjustment" },
    ]);
    expect(await resolveSharedFactoryRequirements(req("/api/credit-notes", "POST"))).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_creditnote" },
    ]);
  });

  it("requires either Stock Transfer tab for shared transfer lifecycle APIs", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/stock-transfers", "POST"))).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transfer" },
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transferorder" },
    ]);
    expect(await resolveSharedFactoryRequirements(req("/api/stock-transfer-revisions/9/approve", "POST"))).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transfer" },
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transferorder" },
    ]);
  });

  it("classifies generic voucher creation by voucher type", async () => {
    expect(
      await resolveSharedFactoryRequirements(req("/api/vouchers", "POST", { voucherType: "Stock Adjustment" }))
    ).toEqual([{ pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_adjustment" }]);

    expect(
      await resolveSharedFactoryRequirements(req("/api/vouchers", "POST", { voucherType: "Stock Transfer" }))
    ).toEqual([
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transfer" },
      { pageKey: "factory/vouchers", tabKey: "hide_tab_vouchers_transferorder" },
    ]);
  });

  it("keeps bulk voucher deletion on Vouchers or View Accounts", async () => {
    expect(await resolveSharedFactoryRequirements(req("/api/vouchers/bulk-delete", "POST"))).toEqual([
      { pageKey: "factory/vouchers" },
      { pageKey: "factory/accounts", tabKey: "hide_tab_accounts_view" },
    ]);
  });
});
