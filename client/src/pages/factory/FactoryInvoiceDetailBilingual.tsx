import { useRoute } from "wouter";
import { Languages } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import FactoryInvoiceDetail from "./FactoryInvoiceDetail";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

export default function FactoryInvoiceDetailBilingual() {
  const [, params] = useRoute("/factory/sales/invoices/:id");
  const orderId = params?.id;
  const { toast } = useToast();

  const download = async (path: string, fileName: string) => {
    if (!orderId) return;
    try {
      await downloadFromUrl(`/api/factory/customer-orders/${orderId}/${path}`, { fileName });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-end gap-2 border-b bg-background px-6 py-2">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <span className="mr-auto text-sm text-muted-foreground">
          Export this invoice using its frozen English or Arabic product snapshots.
        </span>
        <ReportExportMenu
          size="sm"
          data-testid="button-bilingual-document-actions"
          options={[
            {
              id: "excel-en",
              kind: "excel",
              label: "Export Excel (English)",
              onSelect: () => download("export-excel?lang=en", exportFileName(`invoice ${orderId} en`, "xlsx")),
            },
            {
              id: "excel-ar",
              kind: "excel",
              label: "Export Excel (فاتورة عربية)",
              onSelect: () => download("export-excel?lang=ar", exportFileName(`invoice ${orderId} ar`, "xlsx")),
            },
            {
              id: "loading-en",
              kind: "excel",
              label: "Export Excel (English Loading List)",
              onSelect: () => download("pending-export?lang=en", exportFileName(`loading list ${orderId} en`, "xlsx")),
            },
            {
              id: "loading-ar",
              kind: "excel",
              label: "Export Excel (قائمة تحميل عربية)",
              onSelect: () => download("pending-export?lang=ar", exportFileName(`loading list ${orderId} ar`, "xlsx")),
            },
            {
              id: "pdf-en",
              kind: "pdf",
              label: "Export PDF (English)",
              onSelect: () => download("export-pdf?lang=en", exportFileName(`invoice ${orderId} en`, "pdf")),
            },
            {
              id: "pdf-ar",
              kind: "pdf",
              label: "Export PDF (فاتورة عربية)",
              onSelect: () => download("export-pdf?lang=ar", exportFileName(`invoice ${orderId} ar`, "pdf")),
            },
            {
              id: "pdf-en-no-charges",
              kind: "pdf",
              label: "Export PDF (English — No Charges)",
              onSelect: () =>
                download("export-pdf?lang=en&noCharges=1", exportFileName(`invoice ${orderId} en no charges`, "pdf")),
            },
            {
              id: "pdf-ar-no-charges",
              kind: "pdf",
              label: "Export PDF (عربي — بدون رسوم)",
              onSelect: () =>
                download("export-pdf?lang=ar&noCharges=1", exportFileName(`invoice ${orderId} ar no charges`, "pdf")),
            },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        <FactoryInvoiceDetail />
      </div>
    </div>
  );
}
