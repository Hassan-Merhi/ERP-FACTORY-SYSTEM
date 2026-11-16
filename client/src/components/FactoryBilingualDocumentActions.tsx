import { useLocation } from "wouter";
import { Download, FileDown, FileSpreadsheet, PackageCheck } from "lucide-react";
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
import { downloadBlob } from "@/lib/downloadBlob";

function orderIdFromPath(path: string): string | null {
  return (
    path.match(/^\/factory\/sales\/pending-invoices\/(\d+)\/verify/)?.[1] ??
    path.match(/^\/factory\/invoices\/(\d+)\/loading-scan/)?.[1] ??
    null
  );
}

export function FactoryBilingualDocumentActions() {
  const [location] = useLocation();
  const orderId = orderIdFromPath(location);
  const { toast } = useToast();
  if (!orderId) return null;

  const download = async (path: string, fallbackName: string) => {
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
      downloadBlob(blob, encoded ? decodeURIComponent(encoded) : plain || fallbackName);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unable to export",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mb-3 flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <Download className="mr-2 h-4 w-4" />
            Document language
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
            <PackageCheck className="h-4 w-4" /> English loading list
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel dir="rtl">العربية</DropdownMenuLabel>
          <DropdownMenuItem dir="rtl" onClick={() => download("export-pdf?lang=ar", "invoice-ar.pdf")}>
            <FileDown className="h-4 w-4" /> فاتورة PDF عربية
          </DropdownMenuItem>
          <DropdownMenuItem dir="rtl" onClick={() => download("export-excel?lang=ar", "invoice-ar.xlsx")}>
            <FileSpreadsheet className="h-4 w-4" /> فاتورة Excel عربية
          </DropdownMenuItem>
          <DropdownMenuItem dir="rtl" onClick={() => download("pending-export?lang=ar", "loading-ar.xlsx")}>
            <PackageCheck className="h-4 w-4" /> قائمة تحميل عربية
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Français</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => download("export-pdf?lang=fr", "facture-fr.pdf")}>
            <FileDown className="h-4 w-4" /> Facture PDF française
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => download("export-excel?lang=fr", "facture-fr.xlsx")}>
            <FileSpreadsheet className="h-4 w-4" /> Facture Excel française
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => download("pending-export?lang=fr", "chargement-fr.xlsx")}>
            <PackageCheck className="h-4 w-4" /> Liste de chargement française
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
