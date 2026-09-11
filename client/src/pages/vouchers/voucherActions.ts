import { format } from "date-fns";
import { utils, writeFile } from "@/lib/excelHelper";

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
      Amount: parseFloat(entry.amount).toFixed(2),
      Notes: formData.notes || "",
      Optional: formData.optional ? "Yes" : "No",
    }));
    const worksheet = utils.json_to_sheet(exportData);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, `${voucherType} Detailed`);
    const fileName = `${voucherType}_Voucher_Detailed_${voucherDate}.xlsx`;
    await writeFile(workbook, fileName);
    toast({ title: "Export successful", description: `Downloaded ${fileName} with ${validEntries.length} entries.` });
  } else {
    const exportData = [
      {
        "Voucher Type": voucherType,
        Date: voucherDate,
        "Pay From/Receive In": formData.paymentAccountName || "",
        "Total Amount": total.toFixed(2),
        "Number of Entries": validEntries.length,
        Notes: formData.notes || "",
        Optional: formData.optional ? "Yes" : "No",
      },
    ];
    const worksheet = utils.json_to_sheet(exportData);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, `${voucherType} Summary`);
    const fileName = `${voucherType}_Voucher_Summary_${voucherDate}.xlsx`;
    await writeFile(workbook, fileName);
    toast({ title: "Export successful", description: `Downloaded ${fileName}.` });
  }
}
