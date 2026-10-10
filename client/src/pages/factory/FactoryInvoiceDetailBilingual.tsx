import { useRoute } from "wouter";
import { Download, FileDown, FileSpreadsheet, Languages, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import FactoryInvoiceDetail from "./FactoryInvoiceDetail";

export default function FactoryInvoiceDetailBilingual() {
  const [, params] = useRoute("/factory/sales/invoices/:id");
  const orderId = params?.id;
  const { toast } = useToast();

  const download = async (path: string, fallbackName: string) => {
    if (!orderId) return;
    try {
      const response = await fetch(`/api/factory/customer-orders/${orderId}/${path}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("Server returned an empty file");
      const disposition = response.headers.get("content-disposition") || "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
      const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = encoded ? decodeURIComponent(encoded) : plain || fallbackName;
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      }, 10_000);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unable to export document",
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="button-bilingual-document-actions">
              <Download className="mr-2 h-4 w-4" />
              Document Language
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>English</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => download("export-pdf?lang=en", "invoice-en.pdf")}>
              <FileDown className="h-4 w-4" /> English PDF
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => download("export-excel?lang=en", "invoice-en.xlsx")}>
              <FileSpreadsheet className="h-4 w-4" /> English Excel
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => download("pending-export?lang=en", "loading-en.xlsx")}>
              <PackageCheck className="h-4 w-4" /> English Loading List
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel dir="rtl">العربية</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => download("export-pdf?lang=ar", "invoice-ar.pdf")} dir="rtl">
              <FileDown className="h-4 w-4" /> فاتورة PDF عربية
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => download("export-excel?lang=ar", "invoice-ar.xlsx")} dir="rtl">
              <FileSpreadsheet className="h-4 w-4" /> فاتورة Excel عربية
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => download("pending-export?lang=ar", "loading-ar.xlsx")} dir="rtl">
              <PackageCheck className="h-4 w-4" /> قائمة تحميل عربية
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>No charges</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => download("export-pdf?lang=en&noCharges=1", "invoice-en-no-charges.pdf")}>
              English PDF — No Charges
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => download("export-pdf?lang=ar&noCharges=1", "invoice-ar-no-charges.pdf")}
              dir="rtl"
            >
              PDF عربي — بدون رسوم
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1">
        <FactoryInvoiceDetail />
      </div>
    </div>
  );
}
