import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { z } from "zod";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Download } from "lucide-react";
import { ExcelJS } from "@/lib/excelHelper";
import { selectAccountsArray, type AccountsAllPayload } from "@/lib/accountsAllPayload";
import { insertUserSchema, insertCompanySchema, insertUserCompanyRoleSchema } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";

const _userFormSchema = insertUserSchema;
const _companyFormSchema = insertCompanySchema;
const _roleAssignmentSchema = insertUserCompanyRoleSchema.refine(
  (data) => {
    // If role is POS, assignedLocationId must be present
    if (data.role === "POS" && !data.assignedLocationId) {
      return false;
    }
    return true;
  },
  {
    message: "POS roles require an assigned location",
    path: ["assignedLocationId"],
  }
);

type _UserFormData = z.infer<typeof _userFormSchema>;
type _CompanyFormData = z.infer<typeof _companyFormSchema>;
type _RoleAssignmentData = z.infer<typeof _roleAssignmentSchema>;

interface ExportAccount {
  accountId: number;
  type: string;
  name: string;
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

export function ExportAccountsSection() {
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

  const filtered = allAccounts.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));

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
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `Account_Export_${new Date().toLocaleDateString("en-CA")}.xlsx`;
      a.click();
      URL.revokeObjectURL(dlUrl);
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold">Export Accounts</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Select accounts and an optional date range. Each account gets its own sheet in a single Excel workbook.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
              <span>Select Accounts</span>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" data-testid="badge-selected-count">
                  {selectedIds.size} selected
                </Badge>
                <Button variant="ghost" size="sm" onClick={selectAll} data-testid="button-select-all-accounts">
                  Select All
                </Button>
                <Button variant="ghost" size="sm" onClick={clearAll} data-testid="button-clear-accounts">
                  Clear
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-account-search"
            />
            <div className="border rounded-md overflow-y-auto max-h-80 divide-y">
              {sortedGroupKeys.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No accounts found</p>
              )}
              {sortedGroupKeys.map((type) => (
                <div key={type}>
                  <div className="text-xs font-semibold text-muted-foreground px-3 py-2 bg-muted/40 uppercase tracking-wide sticky top-0">
                    {typeLabels[type] || type}
                  </div>
                  {grouped[type].map((acc) => (
                    <label
                      key={acc.accountId}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover-elevate"
                      data-testid={`label-account-${acc.accountId}`}
                    >
                      <Checkbox
                        checked={selectedIds.has(acc.accountId)}
                        onCheckedChange={() => toggleAccount(acc.accountId)}
                        data-testid={`checkbox-account-${acc.accountId}`}
                      />
                      <span className="text-sm flex-1">{acc.name}</span>
                      {acc.balance !== undefined && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {acc.balanceSide}{" "}
                          {Math.abs(Number(acc.balance ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Date Range</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>From</Label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  data-testid="input-export-from-date"
                />
              </div>
              <div className="space-y-1.5">
                <Label>To</Label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  data-testid="input-export-to-date"
                />
              </div>
              <p className="text-xs text-muted-foreground">Leave blank to include all transactions.</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5 space-y-3">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Accounts</span>
                  <span className="font-medium">{selectedIds.size}</span>
                </div>
                {fromDate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">From</span>
                    <span className="font-medium">{fromDate}</span>
                  </div>
                )}
                {toDate && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">To</span>
                    <span className="font-medium">{toDate}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Format</span>
                  <span className="font-medium">Excel (.xlsx)</span>
                </div>
              </div>
              <Button
                className="w-full"
                onClick={handleExport}
                disabled={exporting || selectedIds.size === 0}
                data-testid="button-export-accounts"
              >
                {exporting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Exporting…
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Export to Excel
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
