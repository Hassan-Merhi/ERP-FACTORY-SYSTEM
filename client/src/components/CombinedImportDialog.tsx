import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { utils, writeFile, read } from "@/lib/excelHelper";
import { Download, Package } from "lucide-react";
import type { Location } from "@shared/schema";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StockNameUpdateImport } from "@/components/StockNameUpdateImport";
import { useCompany } from "@/contexts/CompanyContext";

interface OpeningBalanceImportResult {
  message?: string;
}

interface CombinedImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CombinedImportDialog({ open, onOpenChange }: CombinedImportDialogProps) {
  const [pricesFile, setPricesFile] = useState<File | null>(null);
  const [openingFile, setOpeningFile] = useState<File | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isProcessingOpening, setIsProcessingOpening] = useState(false);
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const newItemsImportHref =
    selectedCompany?.companyType === "properties" ? "/properties/import-stock-items" : "/import-stock-items";

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const importMutation = useMutation({
    mutationFn: async (data: Array<{ barcode: string; sellingPrice: string; locationId?: number }>) => {
      const res = await apiRequest("POST", "/api/stock-items/bulk-update-prices", { prices: data });
      return res.json() as Promise<{ message: string; updated: number; notFound: number }>;
    },
    onSuccess: (result) => {
      const noneUpdated = result.updated === 0;
      toast({
        title: noneUpdated ? "No Items Updated" : "Import Complete",
        description: result.message,
        variant: noneUpdated ? "destructive" : "default",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-item-location-prices"] });
      setPricesFile(null);
      setIsProcessing(false);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to import prices",
        variant: "destructive",
      });
      setIsProcessing(false);
    },
  });

  const openingBalanceMutation = useMutation({
    mutationFn: async (
      data: Array<{ barcode: string; openingQty: string; openingRate: string; openingValue: string }>
    ) => {
      const response = await apiRequest("POST", "/api/stock-items/import-opening-balances", { openingBalances: data });
      return response.json() as Promise<OpeningBalanceImportResult>;
    },
    onSuccess: (result) => {
      toast({
        title: "Success",
        description: result.message || "Opening balances imported successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/net-profit-statement"] });
      setOpeningFile(null);
      setIsProcessingOpening(false);
      onOpenChange(false);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to import opening balances",
        variant: "destructive",
      });
      setIsProcessingOpening(false);
    },
  });

  const downloadPricesTemplate = async () => {
    const template = [
      { "Barcode (Item Code)": "ITEM-001", "Selling Price": 100.0 },
      { "Barcode (Item Code)": "ITEM-002", "Selling Price": 200.0 },
    ];

    const ws = utils.json_to_sheet(template);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Prices");
    await writeFile(wb, "selling_prices_template.xlsx");

    toast({
      title: "Template Downloaded",
      description: "Use this template to prepare your selling prices data",
    });
  };

  const handlePricesFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      setPricesFile(e.target.files[0]);
    }
  };

  const handleImportPrices = async () => {
    if (!pricesFile) {
      toast({
        title: "Error",
        description: "Please select a file",
        variant: "destructive",
      });
      return;
    }

    if (!selectedLocation) {
      toast({
        title: "Error",
        description: "Please select a location",
        variant: "destructive",
      });
      return;
    }

    setIsProcessing(true);
    try {
      const arrayBuffer = await pricesFile.arrayBuffer();
      const workbook = await read(arrayBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet) as Array<{
        Barcode?: string;
        "Barcode (Item Code)"?: string;
        "Selling Price"?: string | number;
      }>;

      if (data.length === 0) {
        toast({
          title: "Error",
          description: "No data found in file",
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }

      const prices = data
        .map((row) => ({
          barcode: String(row["Barcode (Item Code)"] || row.Barcode || "").trim(),
          sellingPrice: String(row["Selling Price"] || "0").trim(),
          locationId: parseInt(selectedLocation),
        }))
        .filter((item) => item.barcode);

      if (prices.length === 0) {
        toast({
          title: "Error",
          description: "No valid barcode entries found",
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }

      importMutation.mutate(prices);
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to read file",
        variant: "destructive",
      });
      setIsProcessing(false);
    }
  };

  const downloadOpeningTemplate = async () => {
    const template = [
      { Barcode: "BAR001", Qty: 100, Rate: 10.5, "Total Value": 1050.0 },
      { Barcode: "BAR002", Qty: 50, Rate: 25.0, "Total Value": 1250.0 },
    ];

    const ws = utils.json_to_sheet(template);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, "Opening Balances");
    await writeFile(wb, "opening_balances_template.xlsx");

    toast({
      title: "Template Downloaded",
      description: "Use this template to prepare your opening stock data",
    });
  };

  const handleOpeningFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      setOpeningFile(e.target.files[0]);
    }
  };

  const handleImportOpening = async () => {
    if (!openingFile) {
      toast({
        title: "Error",
        description: "Please select a file",
        variant: "destructive",
      });
      return;
    }

    setIsProcessingOpening(true);
    try {
      const arrayBuffer = await openingFile.arrayBuffer();
      const workbook = await read(arrayBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = utils.sheet_to_json(worksheet) as Array<{
        Barcode?: string;
        Qty?: string | number;
        Rate?: string | number;
        "Total Value"?: string | number;
      }>;

      if (data.length === 0) {
        toast({
          title: "Error",
          description: "No data found in file",
          variant: "destructive",
        });
        setIsProcessingOpening(false);
        return;
      }

      const openingBalances = data
        .map((row) => ({
          barcode: String(row.Barcode || "").trim(),
          openingQty: String(row.Qty || "0").trim(),
          openingRate: String(row.Rate || "0").trim(),
          openingValue: String(row["Total Value"] || "0").trim(),
        }))
        .filter((item) => item.barcode);

      if (openingBalances.length === 0) {
        toast({
          title: "Error",
          description: "No valid barcode entries found",
          variant: "destructive",
        });
        setIsProcessingOpening(false);
        return;
      }

      openingBalanceMutation.mutate(openingBalances);
    } catch (error) {
      toast({
        title: "Error",
        description: getErrorDetails(error).message || "Failed to read file",
        variant: "destructive",
      });
      setIsProcessingOpening(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="dialog-combined-import">
        <DialogHeader>
          <DialogTitle>Import Data</DialogTitle>
          <DialogDescription>Choose what you'd like to import</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="opening" className="w-full">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Dialog sections">
              <TabsTrigger value="opening">Opening Stock</TabsTrigger>
              <TabsTrigger value="prices">Prices</TabsTrigger>
              <TabsTrigger value="items">Items / Names</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="opening" className="space-y-4">
            <div className="space-y-4 mt-4">
              <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                <Package className="h-4 w-4" />
                <AlertDescription>
                  Import opening stock balances for P&L reports. This updates the frozen opening values in stock items -
                  it does NOT affect current inventory.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <label className="text-sm font-medium">File</label>
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleOpeningFileChange}
                  data-testid="input-import-opening-file"
                />
                <p className="text-xs text-muted-foreground">Excel columns: "Barcode", "Qty", "Rate", "Total Value"</p>
              </div>

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={downloadOpeningTemplate}
                data-testid="button-download-opening-template"
              >
                <Download className="h-4 w-4" />
                Download Template
              </Button>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-opening-import"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleImportOpening}
                  disabled={!openingFile || isProcessingOpening}
                  data-testid="button-confirm-opening-import"
                >
                  {isProcessingOpening ? "Importing..." : "Import Opening Balances"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="prices" className="space-y-4">
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Location</label>
                <Select value={selectedLocation} onValueChange={setSelectedLocation}>
                  <SelectTrigger data-testid="select-location-import">
                    <SelectValue placeholder="Select a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Prices will be applied to this location</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">File</label>
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handlePricesFileChange}
                  data-testid="input-import-prices-file"
                />
                <p className="text-xs text-muted-foreground">
                  Excel columns: "Barcode (Item Code)" and "Selling Price". Use the item's code (e.g. ITEM-001) as the
                  barcode.
                </p>
              </div>

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={downloadPricesTemplate}
                data-testid="button-download-prices-template"
              >
                <Download className="h-4 w-4" />
                Download Template
              </Button>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-prices-import">
                  Cancel
                </Button>
                <Button
                  onClick={handleImportPrices}
                  disabled={!pricesFile || isProcessing}
                  data-testid="button-confirm-prices-import"
                >
                  {isProcessing ? "Importing..." : "Import"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="items" className="space-y-4">
            <StockNameUpdateImport />
            <div className="p-4 bg-muted/50 rounded-md space-y-3">
              <p className="text-sm font-medium">Need to create brand-new stock items?</p>
              <p className="text-sm text-muted-foreground">
                Use the dedicated import page for new items with stock-group validation and preview.
              </p>
              <a href={newItemsImportHref}>
                <Button variant="outline" className="w-full" data-testid="button-go-to-import-items">
                  Go to New Items Import Page
                </Button>
              </a>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
