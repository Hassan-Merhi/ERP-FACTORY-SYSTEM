import { useEffect, useRef } from "react";
import { UseFormReturn } from "react-hook-form";
import { parseDateLocal } from "@/components/vouchers/PrintTemplate";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import type { Voucher, VoucherEntry } from "@shared/schema";
import type { VoucherFormData } from "./voucherTypes";
import type {
  BankAccount,
  LedgerAccount,
  Supplier,
  Customer,
  Employee,
  FixedAsset,
  FactorySupplierBasic,
} from "./voucherTypes";

type HydrationEntry = Pick<
  VoucherEntry,
  | "bankAccountId"
  | "ledgerAccountId"
  | "supplierId"
  | "factorySupplierId"
  | "employeeId"
  | "fixedAssetId"
  | "customerId"
  | "debitAmount"
  | "creditAmount"
  | "narration"
>;

type HydrationVoucher = Pick<
  Voucher,
  "id" | "voucherType" | "voucherDate" | "description" | "optional" | "exchangeRate" | "effectiveDate"
> & { entries?: HydrationEntry[] | null };

interface UseVoucherHydrationProps {
  voucherToEdit: HydrationVoucher | null | undefined;
  allAccounts: CombinedAccount[];
  bankAccounts: BankAccount[];
  bankAccountsFetched: boolean;
  ledgerAccounts: LedgerAccount[];
  ledgerAccountsFetched: boolean;
  suppliers: Supplier[];
  suppliersFetched: boolean;
  employees: Employee[];
  fixedAssets: FixedAsset[];
  customers: Customer[];
  customersFetched: boolean;
  factorySuppliersList: FactorySupplierBasic[];
  form: UseFormReturn<VoucherFormData>;
  setTransactionRate: (rate: number) => void;
  setVoucherEffectiveDate: (date: string) => void;
}

export function useVoucherHydration({
  voucherToEdit,
  allAccounts,
  bankAccounts,
  bankAccountsFetched,
  ledgerAccounts,
  ledgerAccountsFetched,
  suppliers,
  suppliersFetched,
  employees,
  fixedAssets,
  customers,
  customersFetched,
  factorySuppliersList,
  form,
  setTransactionRate,
  setVoucherEffectiveDate,
}: UseVoucherHydrationProps) {
  const hydratedVoucherIdRef = useRef<number | null>(null);

  useEffect(() => {
    // This hydration hook is only for Payment/Receipt vouchers. Stock-transfer
    // voucher detail payloads can expose `entries` in a non-array shape, and the
    // transfer editor owns its own hydration path. Never run payment hydration
    // against those payloads.
    if (
      !voucherToEdit ||
      (voucherToEdit.voucherType !== "Payment" && voucherToEdit.voucherType !== "Receipt") ||
      !Array.isArray(voucherToEdit.entries)
    ) {
      return;
    }

    if (hydratedVoucherIdRef.current === voucherToEdit.id) return;
    // Wait until the always-fetched core account lists have settled so that
    // lookups (e.g. ledgerAccounts.find) don't return undefined just because
    // those queries haven't resolved yet.  Without this guard the effect can
    // fire as soon as a fast-loading list (employees, fixedAssets) arrives and
    // the idempotency ref then blocks re-hydration once the real lists load.
    if (!ledgerAccountsFetched || !bankAccountsFetched) return;
    // Per-type guards: only wait for a list when the voucher actually uses it.
    const needsFactorySuppliers = voucherToEdit.entries.some((e) => e.factorySupplierId);
    if (needsFactorySuppliers && factorySuppliersList.length === 0) return;
    const needsSuppliers = voucherToEdit.entries.some((e) => e.supplierId);
    if (needsSuppliers && !suppliersFetched) return;
    const needsCustomers = voucherToEdit.entries.some((e) => e.customerId);
    if (needsCustomers && !customersFetched) return;

    const allEntries = voucherToEdit.entries;
    let paymentEntry = null;

    if (voucherToEdit.voucherType === "Payment") {
      paymentEntry = allEntries.find((entry) => {
        const cr = parseFloat(entry.creditAmount || "0");
        const isLiability = entry.supplierId || entry.employeeId || entry.factorySupplierId;
        return !isLiability && cr > 0;
      });
      if (!paymentEntry) {
        paymentEntry = allEntries.find((entry) => {
          const dr = parseFloat(entry.debitAmount || "0");
          const isLiability = entry.supplierId || entry.employeeId || entry.factorySupplierId;
          return isLiability && dr > 0;
        });
      }
    } else if (voucherToEdit.voucherType === "Receipt") {
      paymentEntry = allEntries.find((entry) => {
        const dr = parseFloat(entry.debitAmount || "0");
        const isLiability = entry.supplierId || entry.employeeId || entry.factorySupplierId;
        return !isLiability && dr > 0;
      });
      if (!paymentEntry) {
        paymentEntry = allEntries.find((entry) => {
          const cr = parseFloat(entry.creditAmount || "0");
          const isLiability = entry.supplierId || entry.employeeId || entry.factorySupplierId;
          return isLiability && cr > 0;
        });
      }
    }

    if (!paymentEntry) return;

    let paymentType: string = "bank";
    let paymentId = 0;
    let paymentName = "";

    if (paymentEntry.customerId) {
      // Customer as Pay-From/Receive-Into: prefer "customer" type so the form
      // restores the customer name correctly.  buildAccountField stamps BOTH
      // customerId AND ledgerAccountId on the same entry, so we must check
      // customerId first or the ledgerAccountId branch would win and show the
      // wrong account name.
      paymentType = "customer";
      paymentId = paymentEntry.customerId;
      const customer = customers.find((c) => c.id === paymentId);
      paymentName = customer?.legalName || "";
    } else if (paymentEntry.bankAccountId) {
      paymentType = "bank";
      paymentId = paymentEntry.bankAccountId;
      const account = bankAccounts.find((b) => b.id === paymentId);
      paymentName = account?.bankName || "";
    } else if (paymentEntry.ledgerAccountId) {
      paymentType = "ledger";
      paymentId = paymentEntry.ledgerAccountId;
      const account = ledgerAccounts.find((l) => l.id === paymentId);
      paymentName = account?.name || "";
    } else if (paymentEntry.supplierId) {
      paymentType = "supplier";
      paymentId = paymentEntry.supplierId;
      const supplier = suppliers.find((s) => s.id === paymentId);
      paymentName = supplier?.legalName || "";
    } else if (paymentEntry.factorySupplierId) {
      paymentType = "factorySupplier";
      paymentId = paymentEntry.factorySupplierId;
      const fs = factorySuppliersList.find((s) => s.id === paymentId);
      paymentName = fs?.name || "";
    } else if (paymentEntry.employeeId) {
      paymentType = "employee";
      paymentId = paymentEntry.employeeId;
      const employee = employees.find((e) => e.id === paymentId);
      paymentName = employee ? `${employee.firstName} ${employee.lastName}` : "";
    } else if (paymentEntry.fixedAssetId) {
      paymentType = "fixedAsset";
      paymentId = paymentEntry.fixedAssetId;
      const asset = fixedAssets.find((f) => f.id === paymentId);
      paymentName = asset?.name || "";
    }

    const payFromCustomerId = paymentEntry.customerId || null;
    const payFromLedgerId = paymentEntry.ledgerAccountId || null;
    const payFromBankId = paymentEntry.bankAccountId || null;
    const payFromSupplierId = paymentEntry.supplierId || null;
    const payFromFactorySupplierId = paymentEntry.factorySupplierId || null;
    const payFromEmployeeId = paymentEntry.employeeId || null;

    const formEntries = voucherToEdit.entries
      .filter((entry) => {
        if (entry === paymentEntry) return false;
        if (payFromLedgerId && entry.ledgerAccountId === payFromLedgerId) return false;
        if (payFromBankId && entry.bankAccountId === payFromBankId) return false;
        if (payFromSupplierId && entry.supplierId === payFromSupplierId) return false;
        if (payFromFactorySupplierId && entry.factorySupplierId === payFromFactorySupplierId) return false;
        if (payFromEmployeeId && entry.employeeId === payFromEmployeeId) return false;
        if (payFromCustomerId && entry.customerId === payFromCustomerId) return false;
        return true;
      })
      .map((entry) => {
        let accountType: "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "customer" | "factorySupplier" =
          "ledger";
        let accountId = 0;
        let accountName = "";
        let amount = "0";

        if (entry.ledgerAccountId) {
          accountType = "ledger";
          accountId = entry.ledgerAccountId;
          const account = ledgerAccounts.find((l) => l.id === accountId);
          accountName = account?.name || "";
        } else if (entry.bankAccountId) {
          accountType = "bank";
          accountId = entry.bankAccountId;
          const account = bankAccounts.find((b) => b.id === accountId);
          accountName = account?.bankName || "";
        } else if (entry.supplierId) {
          accountType = "supplier";
          accountId = entry.supplierId;
          const supplier = suppliers.find((s) => s.id === accountId);
          accountName = supplier?.legalName || "";
        } else if (entry.factorySupplierId) {
          accountType = "factorySupplier";
          accountId = entry.factorySupplierId;
          const fs = factorySuppliersList.find((s) => s.id === accountId);
          accountName = fs?.name || "";
        } else if (entry.employeeId) {
          accountType = "employee";
          accountId = entry.employeeId;
          const employee = employees.find((e) => e.id === accountId);
          accountName = employee ? `${employee.firstName} ${employee.lastName}` : "";
        } else if (entry.fixedAssetId) {
          accountType = "fixedAsset";
          accountId = entry.fixedAssetId;
          const asset = fixedAssets.find((f) => f.id === accountId);
          accountName = asset?.name || "";
        } else if (entry.customerId) {
          accountType = "customer";
          accountId = entry.customerId;
          const customer = customers.find((c) => c.id === accountId);
          accountName = customer?.legalName || "";
        }

        // Customers are assets (receivables), not liabilities, so they follow the
        // same debit/credit direction as bank/ledger accounts, NOT the
        // supplier/employee liability path.
        const isLiabilityPayment = paymentEntry.supplierId || paymentEntry.employeeId || paymentEntry.factorySupplierId;
        if (voucherToEdit.voucherType === "Payment") {
          amount = isLiabilityPayment ? entry.creditAmount || "0" : entry.debitAmount || "0";
        } else if (voucherToEdit.voucherType === "Receipt") {
          amount = isLiabilityPayment ? entry.debitAmount || "0" : entry.creditAmount || "0";
        }

        return { accountType, accountId, accountName, amount, narration: entry.narration || "" };
      })
      .filter((entry) => parseFloat(entry.amount || "0") > 0);

    form.reset({
      paymentAccountType: paymentType as
        "customer" | "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "factorySupplier" | undefined,
      paymentAccountId: paymentId,
      paymentAccountName: paymentName,
      paymentAccountNarration: paymentEntry.narration || "",
      voucherDate: parseDateLocal(voucherToEdit.voucherDate),
      entries:
        formEntries.length > 0
          ? formEntries
          : [
              {
                accountType: "ledger",
                accountId: 0,
                accountName: "",
                amount: "",
              },
            ],
      notes: voucherToEdit.description || "",
      optional: voucherToEdit.optional || false,
    });

    hydratedVoucherIdRef.current = voucherToEdit.id;

    if (voucherToEdit.exchangeRate) {
      setTransactionRate(parseFloat(voucherToEdit.exchangeRate));
    }
    setVoucherEffectiveDate(voucherToEdit.effectiveDate || "");
  }, [
    voucherToEdit,
    allAccounts,
    bankAccounts,
    bankAccountsFetched,
    ledgerAccounts,
    ledgerAccountsFetched,
    suppliers,
    suppliersFetched,
    employees,
    fixedAssets,
    customers,
    customersFetched,
    factorySuppliersList,
    form,
    setVoucherEffectiveDate,
    setTransactionRate,
  ]);

  return { hydratedVoucherIdRef };
}
