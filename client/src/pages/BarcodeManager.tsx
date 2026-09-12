import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Printer, Trash2, Barcode, Check, FileSpreadsheet } from "lucide-react";
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

export default function BarcodeManager() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [manualBarcode, setManualBarcode] = useState("");

  const { data: barcodes = [], isLoading } = useQuery<PendingBarcode[]>({
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
      } catch (_error) {
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

  if (!selectedCompany) {
    return (
      <div className="container mx-auto p-6">
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Please select a company to manage barcodes</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <PageHeader
            title="Barcode Manager"
            subtitle="Import, print, and manage barcode labels for bales"
            icon={<Barcode className="h-5 w-5" />}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} data-testid="button-upload">
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Import Excel
          </Button>
          <Button onClick={handlePrint} disabled={unusedBarcodes.length === 0} data-testid="button-print">
            <Printer className="h-4 w-4 mr-2" />
            Print Labels {selectedIds.length > 0 ? `(${selectedIds.length})` : ""}
          </Button>
        </div>
      </div>

      <Card className="p-4 md:p-6">
        <h2 className="text-lg font-semibold mb-4">Add Barcode Manually</h2>
        <form onSubmit={handleManualAdd} className="flex flex-col sm:flex-row gap-2" noValidate>
          <Input
            placeholder="Enter barcode..."
            value={manualBarcode}
            onChange={(e) => setManualBarcode(e.target.value)}
            className="sm:max-w-md font-mono"
            data-testid="input-manual-barcode"
          />
          <Button type="submit" disabled={!manualBarcode.trim()} data-testid="button-add-barcode">
            Add
          </Button>
        </form>
      </Card>

      <Card className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-lg font-semibold">Pending Barcodes ({unusedBarcodes.length})</h2>
          {selectedIds.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                selectedIds.forEach((id) => deleteBarcode.mutate(id));
                setSelectedIds([]);
              }}
              data-testid="button-delete-selected"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Selected ({selectedIds.length})
            </Button>
          )}
        </div>

        {isLoading ? (
          <p>Loading...</p>
        ) : unusedBarcodes.length === 0 ? (
          <div className="text-center py-12">
            <Barcode className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No pending barcodes. Import from Excel or add manually.</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={selectedIds.length === unusedBarcodes.length && unusedBarcodes.length > 0}
                        onCheckedChange={handleSelectAll}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unusedBarcodes.map((barcode) => (
                    <TableRow key={barcode.id} data-testid={`row-barcode-${barcode.id}`}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.includes(barcode.id)}
                          onCheckedChange={(checked) => handleSelectOne(barcode.id, !!checked)}
                        />
                      </TableCell>
                      <TableCell className="font-mono font-medium">{barcode.barcode}</TableCell>
                      <TableCell>
                        {barcode.printed ? (
                          <Badge variant="secondary">
                            <Check className="h-3 w-3 mr-1" />
                            Printed
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not Printed</Badge>
                        )}
                      </TableCell>
                      <TableCell>{formatDisplayDate(barcode.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteBarcode.mutate(barcode.id)}
                          data-testid={`button-delete-${barcode.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Checkbox
                  checked={selectedIds.length === unusedBarcodes.length && unusedBarcodes.length > 0}
                  onCheckedChange={handleSelectAll}
                />
                <span className="text-sm text-muted-foreground">Select All</span>
              </div>
              {unusedBarcodes.map((barcode) => (
                <Card key={barcode.id} className="p-3" data-testid={`card-barcode-${barcode.id}`}>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedIds.includes(barcode.id)}
                      onCheckedChange={(checked) => handleSelectOne(barcode.id, !!checked)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-sm">{barcode.barcode}</span>
                        <Button variant="ghost" size="icon" onClick={() => deleteBarcode.mutate(barcode.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        {barcode.printed ? (
                          <Badge variant="secondary">
                            <Check className="h-3 w-3 mr-1" />
                            Printed
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not Printed</Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{formatDisplayDate(barcode.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Card>

      {usedBarcodes.length > 0 && (
        <Card className="p-4 md:p-6">
          <h2 className="text-lg font-semibold mb-4">Used Barcodes ({usedBarcodes.length})</h2>
          <p className="text-sm text-muted-foreground mb-4">These barcodes have been scanned and added to inventory</p>
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Barcode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usedBarcodes.slice(0, 10).map((barcode) => (
                <TableRow key={barcode.id}>
                  <TableCell className="font-mono">{barcode.barcode}</TableCell>
                  <TableCell>
                    <Badge variant="default">
                      <Check className="h-3 w-3 mr-1" />
                      In Inventory
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDisplayDate(barcode.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {usedBarcodes.length > 10 && (
            <p className="text-sm text-muted-foreground mt-4">Showing 10 of {usedBarcodes.length} used barcodes</p>
          )}
        </Card>
      )}
    </div>
  );
}
