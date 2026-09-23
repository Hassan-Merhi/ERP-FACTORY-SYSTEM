/**
 * Editing a saved Payment or Receipt loads its ledger entries back into the
 * form. The hook must pick the right "paid from / received into" entry, show
 * the remaining lines with the side that belongs to the form, and never
 * hydrate twice or before the account lists it needs have loaded — a wrong
 * pick here re-saves the voucher with its lines reversed or missing.
 */
import { renderHook } from "@testing-library/react";
import { useVoucherHydration } from "@/pages/vouchers/useVoucherHydration";

const bankAccounts = [{ id: 1, bankName: "Main Bank" }] as any[];
const ledgerAccounts = [
  { id: 10, name: "Rent Expense" },
  { id: 11, name: "Cash" },
  { id: 12, name: "Sales" },
] as any[];
const suppliers = [{ id: 20, legalName: "Acme Supplies" }] as any[];
const customers = [{ id: 30, legalName: "Buyer Ltd" }] as any[];
const employees = [{ id: 40, firstName: "Sara", lastName: "Ali" }] as any[];
const fixedAssets = [{ id: 50, name: "Forklift" }] as any[];
const factorySuppliersList = [{ id: 60, name: "Cotton Co" }] as any[];

function entry(fields: Record<string, unknown>) {
  return {
    bankAccountId: null,
    ledgerAccountId: null,
    supplierId: null,
    factorySupplierId: null,
    employeeId: null,
    fixedAssetId: null,
    customerId: null,
    debitAmount: "0",
    creditAmount: "0",
    narration: null,
    ...fields,
  };
}

function voucher(voucherType: string, entries: any[], extra: Record<string, unknown> = {}) {
  return {
    id: 7,
    voucherType,
    voucherDate: "2026-09-10",
    description: "Edited voucher",
    optional: false,
    exchangeRate: null,
    effectiveDate: null,
    entries,
    ...extra,
  } as any;
}

function run(voucherToEdit: any, overrides: Record<string, unknown> = {}) {
  const form = { reset: vi.fn() };
  const setTransactionRate = vi.fn();
  const setVoucherEffectiveDate = vi.fn();
  const props = {
    voucherToEdit,
    allAccounts: [],
    bankAccounts,
    bankAccountsFetched: true,
    ledgerAccounts,
    ledgerAccountsFetched: true,
    suppliers,
    suppliersFetched: true,
    employees,
    fixedAssets,
    customers,
    customersFetched: true,
    factorySuppliersList,
    form: form as any,
    setTransactionRate,
    setVoucherEffectiveDate,
    ...overrides,
  };
  const hook = renderHook((p) => useVoucherHydration(p), { initialProps: props });
  return { form, setTransactionRate, setVoucherEffectiveDate, hook, props };
}

describe("Payment vouchers", () => {
  it("uses the credited bank as Paid From and lists the debited expenses", () => {
    const { form, setVoucherEffectiveDate } = run(
      voucher(
        "Payment",
        [
          entry({ bankAccountId: 1, creditAmount: "150", narration: "from bank" }),
          entry({ ledgerAccountId: 10, debitAmount: "100", narration: "rent" }),
          entry({ fixedAssetId: 50, debitAmount: "50" }),
        ],
        { effectiveDate: "2026-09-12" }
      )
    );

    const values = form.reset.mock.calls[0][0];
    expect(values).toMatchObject({
      paymentAccountType: "bank",
      paymentAccountId: 1,
      paymentAccountName: "Main Bank",
      paymentAccountNarration: "from bank",
      notes: "Edited voucher",
      optional: false,
    });
    expect(values.voucherDate.getFullYear()).toBe(2026);
    expect(values.voucherDate.getDate()).toBe(10);
    expect(values.entries).toEqual([
      { accountType: "ledger", accountId: 10, accountName: "Rent Expense", amount: "100", narration: "rent" },
      { accountType: "fixedAsset", accountId: 50, accountName: "Forklift", amount: "50", narration: "" },
    ]);
    expect(setVoucherEffectiveDate).toHaveBeenCalledWith("2026-09-12");
  });

  it("treats a debited supplier as Paid From when no asset account was credited, and flips line sides", () => {
    const { form } = run(
      voucher("Payment", [
        entry({ supplierId: 20, debitAmount: "80" }),
        entry({ employeeId: 40, creditAmount: "80", narration: "advance" }),
      ])
    );

    const values = form.reset.mock.calls[0][0];
    expect(values.paymentAccountType).toBe("supplier");
    expect(values.paymentAccountName).toBe("Acme Supplies");
    expect(values.entries).toEqual([
      { accountType: "employee", accountId: 40, accountName: "Sara Ali", amount: "80", narration: "advance" },
    ]);
  });

  it("keeps an empty line when every other line is on the payment account", () => {
    const { form } = run(
      voucher("Payment", [
        entry({ ledgerAccountId: 11, creditAmount: "20" }),
        entry({ ledgerAccountId: 11, debitAmount: "20" }),
      ])
    );
    expect(form.reset.mock.calls[0][0].entries).toEqual([
      { accountType: "ledger", accountId: 0, accountName: "", amount: "" },
    ]);
  });

  it("applies the voucher's stored exchange rate", () => {
    const { setTransactionRate } = run(
      voucher(
        "Payment",
        [entry({ bankAccountId: 1, creditAmount: "5" }), entry({ ledgerAccountId: 10, debitAmount: "5" })],
        { exchangeRate: "600.5" }
      )
    );
    expect(setTransactionRate).toHaveBeenCalledWith(600.5);
  });
});

describe("Receipt vouchers", () => {
  it("uses the debited bank as Received Into and lists credited lines", () => {
    const { form } = run(
      voucher("Receipt", [
        entry({ bankAccountId: 1, debitAmount: "300" }),
        entry({ customerId: 30, creditAmount: "200" }),
        entry({ factorySupplierId: 60, creditAmount: "100" }),
      ])
    );
    const values = form.reset.mock.calls[0][0];
    expect(values.paymentAccountType).toBe("bank");
    expect(values.entries).toEqual([
      { accountType: "customer", accountId: 30, accountName: "Buyer Ltd", amount: "200", narration: "" },
      { accountType: "factorySupplier", accountId: 60, accountName: "Cotton Co", amount: "100", narration: "" },
    ]);
  });

  it("restores a customer Received Into ahead of the ledger id stamped on the same entry", () => {
    const { form } = run(
      voucher("Receipt", [
        entry({ customerId: 30, ledgerAccountId: 12, debitAmount: "90" }),
        entry({ ledgerAccountId: 10, creditAmount: "90" }),
      ])
    );
    const values = form.reset.mock.calls[0][0];
    expect(values).toMatchObject({
      paymentAccountType: "customer",
      paymentAccountId: 30,
      paymentAccountName: "Buyer Ltd",
    });
  });

  it("treats a credited employee as Received Into when no asset account was debited", () => {
    const { form } = run(
      voucher("Receipt", [entry({ employeeId: 40, creditAmount: "25" }), entry({ supplierId: 20, debitAmount: "25" })])
    );
    const values = form.reset.mock.calls[0][0];
    expect(values).toMatchObject({ paymentAccountType: "employee", paymentAccountName: "Sara Ali" });
    // Liability-side receipt: the other line shows its debit.
    expect(values.entries).toEqual([
      { accountType: "supplier", accountId: 20, accountName: "Acme Supplies", amount: "25", narration: "" },
    ]);
  });
});

describe("when hydration waits or skips", () => {
  const simple = () =>
    voucher("Payment", [entry({ bankAccountId: 1, creditAmount: "5" }), entry({ supplierId: 20, debitAmount: "5" })]);

  it("waits for core account lists, then hydrates exactly once per voucher", () => {
    const { form, hook, props } = run(simple(), { ledgerAccountsFetched: false });
    expect(form.reset).not.toHaveBeenCalled();

    hook.rerender({ ...props, ledgerAccountsFetched: true });
    expect(form.reset).toHaveBeenCalledTimes(1);
    expect(hook.result.current.hydratedVoucherIdRef.current).toBe(7);

    hook.rerender({ ...props, ledgerAccountsFetched: true, employees: [...employees] });
    expect(form.reset).toHaveBeenCalledTimes(1);
  });

  it("waits for suppliers, customers or factory suppliers only when the voucher uses them", () => {
    expect(run(simple(), { suppliersFetched: false }).form.reset).not.toHaveBeenCalled();
    expect(run(simple(), { customersFetched: false }).form.reset).toHaveBeenCalled();

    const factory = voucher("Payment", [
      entry({ bankAccountId: 1, creditAmount: "5" }),
      entry({ factorySupplierId: 60, debitAmount: "5" }),
    ]);
    expect(run(factory, { factorySuppliersList: [] }).form.reset).not.toHaveBeenCalled();
    const customer = voucher("Receipt", [
      entry({ bankAccountId: 1, debitAmount: "5" }),
      entry({ customerId: 30, creditAmount: "5" }),
    ]);
    expect(run(customer, { customersFetched: false }).form.reset).not.toHaveBeenCalled();
  });

  it("ignores other voucher types, non-array entries and vouchers with no payment side", () => {
    expect(
      run(voucher("Journal", [entry({ ledgerAccountId: 10, debitAmount: "1" })])).form.reset
    ).not.toHaveBeenCalled();
    expect(run(voucher("Payment", { lines: [] } as any)).form.reset).not.toHaveBeenCalled();
    expect(run(voucher("Payment", [entry({ ledgerAccountId: 10 })])).form.reset).not.toHaveBeenCalled();
    expect(run(null).form.reset).not.toHaveBeenCalled();
  });
});
