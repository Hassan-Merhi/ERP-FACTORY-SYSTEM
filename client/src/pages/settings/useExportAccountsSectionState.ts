// Extracted from ./ExportAccountsSection.tsx
import { searchAny } from "@shared/searchNormalization";
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { ExcelJS } from "@/lib/excelHelper";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { selectAccountsArray, type AccountsAllPayload } from "@/lib/accountsAllPayload";
import { useCompany } from "@/contexts/CompanyContext";

interface ExportAccount {
  accountId: number;
  type: string;
  name: string;
  code?: string | null;
  balance?: string | number | null;
  balanceSide?: string | null;
}

interface AccountTransactionRow {
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  voucherDate?: string | null;
  voucherNumber?: string | null;
  voucherType?: string | null;
  narration?: string | null;
  voucherDescription?: string | null;
}

export function useExportAccountsSectionState() {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  const { data: allAccounts = [] } = useQuery<AccountsAllPayload<ExportAccount>, Error, ExportAccount[]>({
    // Include company ID in the cache key so that switching companies forces a
    // fresh fetch instead of reusing a different company's cached response.
    queryKey: ["/api/accounts/all", selectedCompany?.id],
    select: selectAccountsArray,
  });

  const typeLabels: Record<string, string> = {
    ledger: "Ledger Accounts",
    bank: "Bank Accounts",
    "fixed asset": "Fixed Assets",
    supplier: "Suppliers",
    customer: "Customers",
    employee: "Employees",
    factoryWorker: "Workers",
    factorySupplier: "Factory Suppliers",
  };

  const typeOrder = [
    "ledger",
    "bank",
    "fixed asset",
    "supplier",
    "customer",
    "employee",
    "factoryWorker",
    "factorySupplier",
  ];

  const filtered = allAccounts.filter((a) => searchAny(search, a.name, a.code));

  const grouped = filtered.reduce<Record<string, ExportAccount[]>>((acc, account) => {
    const type = account.type || "ledger";
    if (!acc[type]) acc[type] = [];
    acc[type].push(account);
    return acc;
  }, {});

  const sortedGroupKeys = [...Object.keys(grouped)].sort(
    (a, b) =>
      (typeOrder.indexOf(a) === -1 ? 99 : typeOrder.indexOf(a)) -
      (typeOrder.indexOf(b) === -1 ? 99 : typeOrder.indexOf(b))
  );

  const toggleAccount = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedIds(
      new Set(filtered.filter((a) => a.type !== "customer" && Number(a.balance ?? 0) !== 0).map((a) => a.accountId))
    );
  const clearAll = () => setSelectedIds(new Set());

  const getTransactionUrl = (acc: {
    accountId: string | number | bigint | boolean | null | undefined;
    type: string;
  }): string => {
    const params = new URLSearchParams();
    if (fromDate) params.append("startDate", fromDate);
    if (toDate) params.append("endDate", toDate);
    const qs = params.toString() ? `?${params.toString()}` : "";
    if (acc.type === "factoryWorker") {
      return `/api/factory/workers/${acc.accountId}/statement${qs}`;
    }
    const accountType = (acc.type || "").toLowerCase().replace(/ /g, "-");
    return `/api/accounts/${accountType}/${acc.accountId}/transactions${qs}`;
  };

  const MAX_ROWS_PER_SHEET = 60000;

  const addSheetForChunk = (
    wb: ExcelJS.Workbook,
    baseName: string,
    part: number,
    totalParts: number,
    txnsChunk: AccountTransactionRow[],
    startBalance: number
  ) => {
    const suffix = totalParts > 1 ? ` ${part}` : "";
    const rawName = `${baseName}${suffix}`;
    const sheetName = rawName.replace(/[\\/?*[\]:]/g, "").substring(0, 31);
    const ws = wb.addWorksheet(sheetName);

    ws.columns = [
      { header: "Date", key: "date", width: 14 },
      { header: "Voucher No.", key: "voucherNo", width: 16 },
      { header: "Type", key: "type", width: 16 },
      { header: "Description", key: "description", width: 40 },
      { header: "Debit", key: "debit", width: 14 },
      { header: "Credit", key: "credit", width: 14 },
      { header: "Balance", key: "balance", width: 14 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, size: 11 };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } };
    headerRow.alignment = { horizontal: "center" };

    let runningBalance = startBalance;
    for (const txn of txnsChunk) {
      const debit = parseFloat(String(txn.debitAmount || "0"));
      const credit = parseFloat(String(txn.creditAmount || "0"));
      runningBalance += debit - credit;
      const row = ws.addRow({
        date: txn.voucherDate ? new Date(txn.voucherDate).toLocaleDateString("en-GB") : "",
        voucherNo: txn.voucherNumber || "",
        type: txn.voucherType || "",
        description: txn.narration || txn.voucherDescription || "",
        debit: debit > 0 ? debit : null,
        credit: credit > 0 ? credit : null,
        balance: runningBalance,
      });
      row.getCell("balance").font = { color: { argb: runningBalance >= 0 ? "FF1B5E20" : "FFB71C1C" } };
    }

    if (txnsChunk.length > 0) {
      const totalRow = ws.addRow({
        date: "",
        voucherNo: "",
        type: "",
        description: "TOTAL",
        debit: { formula: `SUM(E2:E${txnsChunk.length + 1})` },
        credit: { formula: `SUM(F2:F${txnsChunk.length + 1})` },
        balance: "",
      });
      totalRow.font = { bold: true };
      totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
    }

    ["debit", "credit", "balance"].forEach((key) => {
      ws.getColumn(key).numFmt = "#,##0.00";
      ws.getColumn(key).alignment = { horizontal: "right" };
    });

    return runningBalance;
  };

  const handleExport = async () => {
    if (selectedIds.size === 0) {
      toast({
        title: "No accounts selected",
        description: "Please select at least one account.",
        variant: "destructive",
      });
      return;
    }
    setExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = "ERP System";
      wb.created = new Date();

      for (const accId of selectedIds) {
        const acc = allAccounts.find((a) => a.accountId === accId);
        if (!acc) continue;

        let txns = [];
        try {
          const res = await fetch(getTransactionUrl(acc), { credentials: "include" });
          if (res.ok) txns = await res.json();
        } catch {
          // Best-effort side request; the user-visible flow does not depend on it completing.
        }

        const baseName = acc.name.replace(/[\\/?*[\]:]/g, "").substring(0, 28) || `Acct_${accId}`;

        if (txns.length <= MAX_ROWS_PER_SHEET) {
          addSheetForChunk(wb, baseName, 1, 1, txns, 0);
        } else {
          const totalParts = Math.ceil(txns.length / MAX_ROWS_PER_SHEET);
          let carryBalance = 0;
          for (let part = 1; part <= totalParts; part++) {
            const chunk = txns.slice((part - 1) * MAX_ROWS_PER_SHEET, part * MAX_ROWS_PER_SHEET);
            carryBalance = addSheetForChunk(wb, baseName, part, totalParts, chunk, carryBalance);
          }
        }
      }

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      downloadBlob(blob, exportFileName("account export", "xlsx"));
      toast({
        title: "Export complete",
        description: `${selectedIds.size} account${selectedIds.size !== 1 ? "s" : ""} exported successfully.`,
      });
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };
  return {
    selectedIds,
    fromDate,
    setFromDate,
    toDate,
    setToDate,
    exporting,
    search,
    setSearch,
    typeLabels,
    grouped,
    sortedGroupKeys,
    toggleAccount,
    selectAll,
    clearAll,
    handleExport,
  };
}
