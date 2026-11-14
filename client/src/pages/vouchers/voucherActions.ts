import { format } from "date-fns";
import { exportOperationalWorkbook } from "@/lib/operationalExcelExport";

type VoucherExportEntry = {
  accountId: number;
  amount: string;
  accountName?: string;
  accountType?: string;
};

type VoucherExportForm = {
  voucherDate?: Date;
  entries: VoucherExportEntry[];
  paymentAccountName?: string;
  notes?: string;
  optional?: boolean;
};

interface ExportParams {
  formData: VoucherExportForm;
  activeTab: string;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  detailed: boolean;
}

export async function exportVoucherHelper({ formData, activeTab, toast, detailed }: ExportParams) {
  const voucherType = activeTab === "payment" ? "Payment" : "Receipt";
  const voucherDate = formData.voucherDate
    ? format(formData.voucherDate, "yyyy-MM-dd")
    : format(new Date(), "yyyy-MM-dd");
  const validEntries = formData.entries.filter((e) => e.accountId > 0 && parseFloat(e.amount) > 0);

  if (validEntries.length === 0) {
    toast({
      title: "No data to export",
      description: "Add at least one entry before exporting.",
      variant: "destructive",
    });
    return;
  }

  const total = validEntries.reduce((sum: number, e) => sum + (parseFloat(e.amount) || 0), 0);

  if (detailed) {
    const exportData = validEntries.map((entry) => ({
      "Voucher Type": voucherType,
      Date: voucherDate,
      "Pay From/Receive In": formData.paymentAccountName || "",
      Account: entry.accountName || "",
      "Account Type": entry.accountType || "",
      Amount: parseFloat(entry.amount),
      Notes: formData.notes || "",
      Optional: formData.optional ? "Yes" : "No",
    }));
    const fileName = `${voucherType}_Voucher_Detailed_${voucherDate}.xlsx`;
    await exportOperationalWorkbook({
      title: voucherType + " Voucher — Detailed",
      fileName,
      sheets: [
        {
          name: voucherType + " Detailed",
          columns: [
            { key: "Voucher Type", header: "Voucher Type", width: 18 },
            { key: "Date", header: "Date", width: 17 },
            { key: "Pay From/Receive In", header: "Pay From/Receive In", width: 26 },
            { key: "Account", header: "Account", width: 30 },
            { key: "Account Type", header: "Account Type", width: 20 },
            { key: "Amount", header: "Amount", type: "money", width: 18 },
            { key: "Notes", header: "Notes", width: 40 },
            { key: "Optional", header: "Optional", width: 12 },
          ],
          rows: exportData,
        },
      ],
    });
    toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} entries.` });
  } else {
    const exportData = [
      {
        "Voucher Type": voucherType,
        Date: voucherDate,
        "Pay From/Receive In": formData.paymentAccountName || "",
        "Total Amount": total,
        "Number of Entries": validEntries.length,
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      },
    ];
    const fileName = `${voucherType}_Voucher_Summary_${voucherDate}.xlsx`;
    await exportOperationalWorkbook({
      title: voucherType + " Voucher — Summary",
      fileName,
      sheets: [
        {
          name: voucherType + " Summary",
          columns: [
            { key: "Voucher Type", header: "Voucher Type", width: 18 },
            { key: "Date", header: "Date", width: 17 },
            { key: "Pay From/Receive In", header: "Pay From/Receive In", width: 26 },
            { key: "Total Amount", header: "Total Amount", type: "money", width: 18 },
            { key: "Number of Entries", header: "Number of Entries", type: "integer", width: 20 },
            { key: "Notes", header: "Notes", width: 40 },
            { key: "Optional", header: "Optional", width: 12 },
          ],
          rows: exportData,
        },
      ],
    });
    toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
  }
}
