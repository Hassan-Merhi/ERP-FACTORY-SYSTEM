import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { buildInternalProductCode, NO_BRAND } from "./retailInventoryTypes";

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fileName, setFileName] = useState("");

  const downloadTemplate = async () => {
    const sheet = utils.json_to_sheet([
      {
        Name: "Runner",
        Brand: "Acme",
        Size: "42",
        Barcode: "6001234567890",
        Cost: 25,
        Price: 49.99,
        Qty: 12,
        Location: "MAIN",
        Category: "Shoes",
      },
      {
        Name: "Runner",
        Brand: "Acme",
        Size: "43",
        Barcode: "6001234567891",
        Cost: 25,
        Price: 49.99,
        Qty: 8,
        Location: "MAIN",
        Category: "Shoes",
      },
    ]);
    const book = utils.book_new();
    utils.book_append_sheet(book, sheet, "Retail Products");
    await writeFile(book, "retail_variant_inventory_template.xlsx");
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!rows.length) throw new Error("Choose a populated Excel file first");
      const response = await apiRequest("POST", "/api/retail/import", {
        rows,
        idempotencyKey: `retail-import-${
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`
        }`,
      });
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["retail-products"] });
      queryClient.invalidateQueries({ queryKey: ["retail-brands"] });
      toast({
        title: "Retail import complete",
        description: `${result.rowsProcessed} rows · ${result.productsCreated} new products · ${result.variantsCreated} new variants`,
      });
      onOpenChange(false);
      setRows([]);
      setFileName("");
    },
    onError: (error: Error) => toast({ title: "Import failed", description: error.message, variant: "destructive" }),
  });

  const handleFile = async (file?: File) => {
    if (!file) return;
    try {
      const workbook = await read(await file.arrayBuffer());
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const mapped = raw.map((source) => {
        const row = new Map(Object.entries(source).map(([key, value]) => [key.trim().toLowerCase(), value]));
        const name = String(row.get("name") ?? "").trim();
        const brand = String(row.get("brand") ?? NO_BRAND).trim() || NO_BRAND;
        const suppliedCode = String(row.get("code") ?? "").trim();
        return {
          code: suppliedCode || buildInternalProductCode(name, brand),
          name,
          brand,
          size: String(row.get("size") ?? "").trim(),
          barcode: String(row.get("barcode") ?? "").trim(),
          cost: Number(row.get("cost") ?? 0),
          price: Number(row.get("price") ?? 0),
          qty: Number(row.get("qty") ?? 0),
          location: String(row.get("location") ?? "").trim(),
          category: String(row.get("category") ?? "").trim() || undefined,
        };
      });
      const required = ["name", "size", "barcode", "location"] as const;
      const badIndex = mapped.findIndex((row) => required.some((key) => !String(row[key] ?? "").trim()));
      if (badIndex >= 0) throw new Error(`Row ${badIndex + 2} is missing Name, Size, Barcode or Location`);
      setRows(mapped);
      setFileName(file.name);
      toast({ title: "File ready", description: `${mapped.length} rows validated for import` });
    } catch (error) {
      setRows([]);
      toast({
        title: "Could not read file",
        description: error instanceof Error ? error.message : "Invalid Excel file",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Retail Products</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Columns: Name | Brand | Size | Barcode | Cost | Price | Qty | Location | Category. Brand can be left blank for
          Other / No Brand. Rows with the same product name and brand are grouped together automatically.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={downloadTemplate}>
            Download template
          </Button>
        </div>
        <Input type="file" accept=".xlsx,.xls" onChange={(e) => handleFile(e.target.files?.[0])} />
        {fileName && (
          <p className="text-sm">
            {fileName}: <strong>{rows.length}</strong> rows ready
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!rows.length || importMutation.isPending} onClick={() => importMutation.mutate()}>
            {importMutation.isPending ? "Importing…" : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
