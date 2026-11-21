// Extracted from ./BarcodeManager.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { utils, read } from "@/lib/excelHelper";

interface PendingBarcode {
  id: number;
  companyId: number;
  barcode: string;
  category: string | null;
  grade: string | null;
  origin: string | null;
  printed: boolean;
  used: boolean;
  createdAt: string;
}

export function useBarcodeManagerState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manualBarcode, setManualBarcode] = useState("");

  const {
    data: barcodes = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<PendingBarcode[]>({
    queryKey: ["/api/pending-barcodes", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const importBarcodes = useMutation({
    mutationFn: async (barcodeList: string[]) => {
      return await apiRequest("POST", "/api/pending-barcodes/import", {
        barcodes: barcodeList.map((b) => ({ barcode: b })),
      });
    },
    onSuccess: async (res) => {
      const data = (await res.json()) as { count: number };
      queryClient.invalidateQueries({ queryKey: ["/api/pending-barcodes", selectedCompany?.id] });
      toast({ title: `Imported ${data.count} barcodes` });
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const addBarcode = useMutation({
    mutationFn: async (barcode: string) => {
      return await apiRequest("POST", "/api/pending-barcodes", { barcode });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pending-barcodes", selectedCompany?.id] });
      toast({ title: "Barcode added" });
      setManualBarcode("");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error adding barcode", description: error.message, variant: "destructive" });
    },
  });

  const deleteBarcode = useMutation({
    mutationFn: async (id: number) => {
      return await apiRequest("DELETE", `/api/pending-barcodes/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pending-barcodes", selectedCompany?.id] });
      toast({ title: "Barcode deleted" });
    },
  });

  const markAsPrinted = useMutation({
    mutationFn: async (ids: number[]) => {
      return await apiRequest("PATCH", "/api/pending-barcodes/mark-printed", { ids });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pending-barcodes", selectedCompany?.id] });
      setSelectedIds([]);
      toast({ title: "Marked as printed" });
    },
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = await read(data);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

        const barcodeList: string[] = [];
        jsonData.forEach((row, index) => {
          const firstCell = row[0];
          if (index === 0 && typeof firstCell === "string" && firstCell.toLowerCase().includes("barcode")) {
            return;
          }
          const barcode = firstCell == null ? "" : String(firstCell).trim();
          if (barcode) {
            barcodeList.push(barcode);
          }
        });

        if (barcodeList.length > 0) {
          importBarcodes.mutate(barcodeList);
        } else {
          toast({ title: "No barcodes found in file", variant: "destructive" });
        }
      } catch {
        toast({ title: "Error reading file", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handlePrint = () => {
    const toPrint =
      selectedIds.length > 0
        ? barcodes.filter((b) => selectedIds.includes(b.id))
        : barcodes.filter((b) => !b.printed && !b.used);

    if (toPrint.length === 0) {
      toast({ title: "No barcodes to print", variant: "destructive" });
      return;
    }

    const printWindow = window.open("", "_blank");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Barcode Labels</title>
        <style>
          @page { 
            margin: 0;
            size: 100mm 75mm;
          }
          * {
            box-sizing: border-box;
          }
          body { 
            font-family: Arial, sans-serif; 
            margin: 0; 
            padding: 0;
          }
          .label {
            width: 100mm;
            height: 75mm;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            page-break-after: always;
            text-align: center;
            padding: 5mm;
          }
          .label:last-child {
            page-break-after: auto;
          }
          .barcode-img { 
            width: 80mm;
            height: auto;
            max-height: 35mm;
          }
          .barcode-text { 
            font-size: 24px; 
            font-weight: bold; 
            margin-top: 4mm;
            font-family: monospace;
          }
          .barcode-info {
            font-size: 14px;
            color: #666;
            margin-top: 2mm;
          }
          @media print {
            body {
              width: 100mm;
            }
            .label {
              width: 100mm;
              height: 75mm;
            }
          }
        </style>
      </head>
      <body>
        ${toPrint
          .map(
            (b) => `
          <div class="label">
            <img class="barcode-img" src="/api/barcode/${encodeURIComponent(b.barcode)}" alt="${b.barcode}" />
            <div class="barcode-text">${b.barcode}</div>
            ${b.category || b.grade || b.origin ? `<div class="barcode-info">${[b.category, b.grade, b.origin].filter(Boolean).join(" | ")}</div>` : ""}
          </div>
        `
          )
          .join("")}
        <script>
          window.onload = function() {
            setTimeout(function() { window.print(); }, 500);
          };
        </script>
      </body>
      </html>
    `);
    printWindow.document.close();

    markAsPrinted.mutate(toPrint.map((b) => b.id));
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(barcodes.filter((b) => !b.used).map((b) => b.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds([...selectedIds, id]);
    } else {
      setSelectedIds(selectedIds.filter((i) => i !== id));
    }
  };

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualBarcode.trim()) {
      addBarcode.mutate(manualBarcode.trim());
    }
  };

  const unusedBarcodes = barcodes.filter((b) => !b.used);
  const usedBarcodes = barcodes.filter((b) => b.used);
  return {
    selectedCompany,
    formatDisplayDate,
    fileInputRef,
    selectedIds,
    setSelectedIds,
    manualBarcode,
    setManualBarcode,
    isLoading,
    isError,
    barcodes,
    refetch,
    deleteBarcode,
    handleFileUpload,
    handlePrint,
    handleSelectAll,
    handleSelectOne,
    handleManualAdd,
    unusedBarcodes,
    usedBarcodes,
  };
}
