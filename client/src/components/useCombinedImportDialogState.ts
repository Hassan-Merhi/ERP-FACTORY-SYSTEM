// Extracted from ./CombinedImportDialog.tsx
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { utils, writeFile, read } from "@/lib/excelHelper";
import type { Location } from "@shared/schema";
import { useCompany } from "@/contexts/CompanyContext";

interface OpeningBalanceImportResult {
  message?: string;
}

export interface CombinedImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function useCombinedImportDialogState({ onOpenChange }: Pick<CombinedImportDialogProps, "onOpenChange">) {
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
        title: "Import failed",
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
        title: "Imported",
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
        title: "Import failed",
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
        title: "Missing information",
        description: "Please select a file",
        variant: "destructive",
      });
      return;
    }

    if (!selectedLocation) {
      toast({
        title: "Missing information",
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
          title: "Import failed",
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
          title: "Import failed",
          description: "No valid barcode entries found",
          variant: "destructive",
        });
        setIsProcessing(false);
        return;
      }

      importMutation.mutate(prices);
    } catch (error) {
      toast({
        title: "Import failed",
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
        title: "Missing information",
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
          title: "Import failed",
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
          title: "Import failed",
          description: "No valid barcode entries found",
          variant: "destructive",
        });
        setIsProcessingOpening(false);
        return;
      }

      openingBalanceMutation.mutate(openingBalances);
    } catch (error) {
      toast({
        title: "Import failed",
        description: getErrorDetails(error).message || "Failed to read file",
        variant: "destructive",
      });
      setIsProcessingOpening(false);
    }
  };
  return {
    pricesFile,
    openingFile,
    selectedLocation,
    setSelectedLocation,
    isProcessing,
    isProcessingOpening,
    newItemsImportHref,
    locations,
    downloadPricesTemplate,
    handlePricesFileChange,
    handleImportPrices,
    downloadOpeningTemplate,
    handleOpeningFileChange,
    handleImportOpening,
  };
}
