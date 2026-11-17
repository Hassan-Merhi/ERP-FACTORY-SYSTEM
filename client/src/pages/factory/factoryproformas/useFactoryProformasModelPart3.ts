// Extracted from ./useFactoryProformasModel.ts to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useMutation } from "@tanstack/react-query";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { utils as excelUtils, read as readExcel, writeFile as writeExcel } from "@/lib/excelHelper";
import { useFactoryProformasModelPart1 } from "./useFactoryProformasModelPart1";

export function useFactoryProformasModelPart3({
  customerId,
  excelImportName,
  invalidateCustomerProformas,
  modeApiRequest,
  setExcelImportDestination,
  setExcelImportErrors,
  setExcelImportLines,
  setExcelImportLoading,
  setExcelImportName,
  setIsExcelImportOpen,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryProformasModelPart1>>,
  | "customerId"
  | "excelImportName"
  | "invalidateCustomerProformas"
  | "modeApiRequest"
  | "setExcelImportDestination"
  | "setExcelImportErrors"
  | "setExcelImportLines"
  | "setExcelImportLoading"
  | "setExcelImportName"
  | "setIsExcelImportOpen"
  | "toast"
>) {
  const bulkImportMutation = useMutation({
    mutationFn: async (data: {
      customerId: number;
      name: string;
      destination: string;
      isActive: boolean;
      lines: unknown[];
    }) => {
      const res = await modeApiRequest("POST", "/api/factory/customer-proformas/bulk", data);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Proforma created", description: "Excel data imported successfully" });
      invalidateCustomerProformas();
      setIsExcelImportOpen(false);
      setExcelImportName("");
      setExcelImportDestination("");
      setExcelImportLines([]);
      setExcelImportErrors([]);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const downloadProformaTemplate = async () => {
    const wb = excelUtils.book_new();
    const sampleData = [
      { "Article Code": "A001", "Product Name": "Mixed Cotton Bales", Quantity: 50, "Price Per Bale": 45.0 },
      { "Article Code": "A002", "Product Name": "White Cotton Bales", Quantity: 30, "Price Per Bale": 52.5 },
      { "Article Code": "B001", "Product Name": "Polyester Mix Bales", Quantity: 20, "Price Per Bale": 38.0 },
    ];
    const sheet = excelUtils.json_to_sheet(sampleData);
    excelUtils.book_append_sheet(wb, sheet, "Proforma");
    await writeExcel(wb, "proforma_template.xlsx");
  };

  const handleExcelFile = async (file: File) => {
    setExcelImportLoading(true);
    setExcelImportErrors([]);
    setExcelImportLines([]);
    try {
      const workbook = await readExcel(file);
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) {
        setExcelImportErrors(["No sheets found in this file"]);
        return;
      }
      const rows = excelUtils.sheet_to_json(firstSheet);
      if (rows.length === 0) {
        setExcelImportErrors(["The sheet appears to be empty"]);
        return;
      }

      // Smart column detection — case-insensitive, multiple aliases
      const normalize = (s: string) =>
        String(s ?? "")
          .toLowerCase()
          .replace(/[\s_-]/g, "");
      const findCol = (row: Record<string, unknown>, aliases: string[]): string => {
        const keys = Object.keys(row);
        for (const alias of aliases) {
          const found = keys.find((k) => normalize(k) === alias);
          if (found) return String(row[found] ?? "").trim();
        }
        return "";
      };

      const parsed: { articleCode: string; productName: string; quantity: string; pricePerBale: string }[] = [];
      const errors: string[] = [];

      rows.forEach((row, i) => {
        const articleCode = findCol(row, ["articlecode", "code", "article", "artcode", "sku", "ref"]);
        const productName = findCol(row, ["productname", "name", "product", "description", "item", "itemname"]);
        const quantity = findCol(row, ["quantity", "qty", "bales", "count"]);
        const pricePerBale = findCol(row, ["priceperbale", "price", "rate", "unitprice", "saleprice", "sellingprice"]);

        if (!articleCode && !productName) {
          errors.push(`Row ${i + 2}: Missing article code and product name — skipped`);
          return;
        }
        if (!articleCode) {
          errors.push(`Row ${i + 2}: Missing article code — skipped`);
          return;
        }
        if (!productName) {
          errors.push(`Row ${i + 2}: Missing product name — skipped`);
          return;
        }
        const qty = parseInt(quantity);
        if (isNaN(qty) || qty <= 0) {
          errors.push(`Row ${i + 2}: Invalid quantity "${quantity}" — skipped`);
          return;
        }

        parsed.push({ articleCode, productName, quantity: String(qty), pricePerBale: pricePerBale || "0" });
      });

      if (errors.length > 0) setExcelImportErrors(errors);
      if (parsed.length === 0) {
        setExcelImportErrors((prev) => [
          ...prev,
          "No valid rows found. Check that columns are named: Article Code, Product Name, Quantity, Price Per Bale",
        ]);
        return;
      }
      setExcelImportLines(parsed);
      // Suggest a proforma name from the filename
      if (!excelImportName) {
        const base = file.name
          .replace(/\.(xlsx?|csv)$/i, "")
          .replace(/[_-]+/g, " ")
          .trim();
        setExcelImportName(base || "Imported Proforma");
      }
    } catch (err) {
      setExcelImportErrors([`Failed to read file: ${getErrorDetails(err).optionalMessage || "Unknown error"}`]);
    } finally {
      setExcelImportLoading(false);
    }
  };

  const saveAgreedPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      if (!customerId) throw new Error("No customer selected");
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-price-lists/${customerId}/from-proforma/${proformaId}`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-price-lists") });
      toast({
        title: "Agreed prices saved",
        description: `${result.saved} price${result.saved !== 1 ? "s" : ""} saved for destination ${result.destination}. Existing proformas were not changed.`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const applyAgreedPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-proformas/${proformaId}/apply-agreed-prices`, {});
      return res.json() as Promise<{
        updated: number;
        skipped: number;
        fixed: number;
        unchanged: number;
        destination: string;
      }>;
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const matched = result.updated + result.unchanged;
      toast({
        title:
          result.updated > 0
            ? "Saved Agreed Prices Applied"
            : matched > 0
              ? "Saved Agreed Prices Already Current"
              : "No Matching Saved Agreed Prices",
        description: `${matched} matched for ${result.destination}. ${result.updated} updated, ${result.unchanged} already current, ${result.skipped} without saved prices, ${result.fixed} locked.`,
      });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const applyCatalogPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-proformas/${proformaId}/apply-catalog-prices`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const msg =
        result.skipped > 0
          ? `${result.updated} line(s) updated, ${result.skipped} skipped (no selling price)`
          : `${result.updated} line(s) updated with selling prices`;
      toast({ title: "Selling Prices Applied", description: msg });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  const applyProductionPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-proformas/${proformaId}/apply-production-prices`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const msg =
        result.skipped > 0
          ? `${result.updated} line(s) updated, ${result.skipped} skipped (no production price)`
          : `${result.updated} line(s) updated with production prices`;
      toast({ title: "Production Prices Applied", description: msg });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });
  return {
    applyAgreedPricesMutation,
    applyCatalogPricesMutation,
    applyProductionPricesMutation,
    bulkImportMutation,
    downloadProformaTemplate,
    handleExcelFile,
    saveAgreedPricesMutation,
  };
}
