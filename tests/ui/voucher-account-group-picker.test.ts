/**
 * Voucher account selectors must request the voucher-picker ledger profile,
 * which the server uses to drop Group headings and legacy parent ledgers
 * (behaviour covered by tests/voucher-account-group-picker.database.test.ts).
 *
 * Each selector is mounted with a recording useQuery; the assertion is on the
 * ledger-accounts query key it actually asks for, not on its source text.
 */
import { createElement } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ queryKeys: [] as unknown[][] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    harness.queryKeys.push(options.queryKey);
    return { data: undefined, isFetched: true, isLoading: false, error: null };
  },
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
  keyStartsWith: () => () => false,
  invalidateContainerLandedCostQueries: vi.fn(),
  queryClient: { invalidateQueries: vi.fn(async () => undefined), getQueryData: () => undefined },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);

import { useVoucherQueries } from "@/pages/vouchers/useVoucherQueries";
import { useJournalFormModel } from "@/pages/vouchers/journalform/useJournalFormModel";
import { useVoucherEditQueries } from "@/pages/voucher-edit/useVoucherEditQueries";
import { VoucherEditDialog } from "@/components/VoucherEditDialog";

function mount(useHook: () => unknown) {
  function Harness() {
    useHook();
    return null;
  }
  render(createElement(Harness));
}

/** Ledger-account query URLs requested so far, with their query string parsed. */
function ledgerAccountRequests() {
  return harness.queryKeys
    .map((key) => key?.[0])
    .filter((first): first is string => typeof first === "string")
    .map((first) => new URL(first, "http://test.local"))
    .filter((url) => url.pathname === "/api/ledger-accounts");
}

function expectVoucherPickerProfile() {
  const requests = ledgerAccountRequests();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.map((url) => url.searchParams.get("profile"))).toEqual(requests.map(() => "voucher-picker"));
}

describe("voucher account selectors request the voucher-picker ledger profile", () => {
  beforeEach(() => {
    harness.queryKeys.length = 0;
  });

  it("payment/receipt voucher queries", () => {
    mount(() =>
      useVoucherQueries({
        selectedCompany: { id: 4, companyType: "trading" },
        isFactoryCompany: false,
        isPropertiesCompany: false,
        voucherIdToEdit: undefined,
        accountPickersNeeded: true,
        activeTab: "payment",
        isPOS: false,
      } as Parameters<typeof useVoucherQueries>[0])
    );
    expectVoucherPickerProfile();
  });

  it("journal form model", () => {
    mount(() => useJournalFormModel({} as Parameters<typeof useJournalFormModel>[0]));
    expectVoucherPickerProfile();
  });

  it("voucher edit page queries", () => {
    mount(() => useVoucherEditQueries({ id: "12", selectedCompanyId: 1 }));
    expectVoucherPickerProfile();
  });

  it("voucher edit dialog", () => {
    render(createElement(VoucherEditDialog, { voucherId: 12, open: true, onOpenChange: vi.fn() }));
    expectVoucherPickerProfile();
  });
});
