import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Upload, Download, CheckCircle2 } from "lucide-react";
import { utils, read, ExcelJS } from "@/lib/excelHelper";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

// ═════════════════════════════════════════════════════════════════════════════
// Update Categories tab
// ═════════════════════════════════════════════════════════════════════════════

interface CategoryRow {
  itemCode: string;
  categoryName: string;
  status: "ok" | "duplicate" | "empty";
}

export function UpdateCategoriesTab() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<CategoryRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{
    updated: number;
    notFound: number;
    categoryNotFound: number;
    notFoundCodes: string[];
    categoryNotFoundNames: string[];
  } | null>(null);

  const downloadTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Categories");
    ws.columns = [
      { header: "Item Code", key: "itemCode", width: 20 },
      { header: "Category Name", key: "categoryName", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ itemCode: "ITEM001", categoryName: "AJ" });
    ws.addRow({ itemCode: "ITEM002", categoryName: "AJ" });
    ws.addRow({ itemCode: "ITEM003", categoryName: "BL" });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "update_categories_template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Template Downloaded", description: "Fill in Item Code and Category Name, then upload" });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setResult(null);
    try {
      const data = await f.arrayBuffer();
      const workbook = await read(data);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = utils.sheet_to_json(worksheet);
      if (jsonData.length === 0) {
        toast({ title: "Empty File", variant: "destructive" });
        return;
      }

      const keys = Object.keys(jsonData[0]);
      const itemCodeKey = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === "itemcode") ?? keys[0];
      const catKey = keys.find((k) => k.toLowerCase().replace(/[\s_]/g, "") === "categoryname") ?? keys[1];

      const seen = new Set<string>();
      const parsed: CategoryRow[] = jsonData.map((row) => {
        const itemCode = String(row[itemCodeKey] || "").trim();
        const categoryName = String(row[catKey] || "").trim();
        const key = itemCode.toLowerCase();
        let status: CategoryRow["status"] = "ok";
        if (!itemCode || !categoryName) status = "empty";
        else if (seen.has(key)) status = "duplicate";
        else seen.add(key);
        return { itemCode, categoryName, status };
      });

      setRows(parsed);
      const valid = parsed.filter((r) => r.status === "ok").length;
      toast({ title: "File Loaded", description: `${valid} valid rows ready to update` });
    } catch {
      toast({ title: "Error Reading File", description: "Please upload a valid .xlsx file", variant: "destructive" });
    }
  };

  const handleImport = async () => {
    const valid = rows.filter((r) => r.status === "ok");
    if (valid.length === 0) {
      toast({ title: "Nothing to import", variant: "destructive" });
      return;
    }
    setIsProcessing(true);
    try {
      const res = await apiRequest("POST", "/api/stock-items/update-categories", {
        rows: valid.map((r) => ({ itemCode: r.itemCode, categoryName: r.categoryName })),
      });
      const data = await res.json();
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      toast({
        title: "Update Complete",
        description: `${data.updated} items updated${data.notFound ? `, ${data.notFound} item codes not found` : ""}${data.categoryNotFound ? `, ${data.categoryNotFound} category names not found` : ""}`,
        variant: data.notFound > 0 || data.categoryNotFound > 0 ? "destructive" : "default",
      });
    } catch (err) {
      toast({ title: "Update Failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const validCount = rows.filter((r) => r.status === "ok").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Update Item Categories</CardTitle>
          <CardDescription>
            Upload an Excel file to bulk-assign categories (stock groups) to existing stock items by their item code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-1">
            <p className="font-medium">Required columns</p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded">Item Code</span> — must match an existing item's
              code exactly
            </p>
            <p className="text-muted-foreground">
              <span className="font-mono bg-background px-1 rounded">Category Name</span> — must match an existing stock
              group name exactly
            </p>
            <p className="text-muted-foreground">
              Each row updates one item. Duplicate item codes are skipped (first row wins).
            </p>
          </div>

          <Button variant="outline" onClick={downloadTemplate} data-testid="button-download-categories-template">
            <Download className="h-4 w-4 mr-2" /> Download Template
          </Button>

          <div className="space-y-2">
            <Label htmlFor="cat-file-upload">Select Excel File</Label>
            <Input
              id="cat-file-upload"
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              disabled={isProcessing}
              data-testid="input-categories-file-upload"
            />
          </div>

          {result && (
            <Alert variant={result.notFound > 0 || result.categoryNotFound > 0 ? "destructive" : "default"}>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="space-y-1">
                <p>
                  <strong>{result.updated}</strong> items updated successfully
                </p>
                {result.notFound > 0 && (
                  <div>
                    <p className="text-muted-foreground">
                      {result.notFound} item code(s) not found:{" "}
                      <span className="font-mono text-xs">
                        {result.notFoundCodes.slice(0, 8).join(", ")}
                        {result.notFoundCodes.length > 8 ? ` +${result.notFoundCodes.length - 8} more` : ""}
                      </span>
                    </p>
                  </div>
                )}
                {result.categoryNotFound > 0 && (
                  <div>
                    <p className="text-muted-foreground">
                      {result.categoryNotFound} category name(s) not found:{" "}
                      <span className="font-mono text-xs">
                        {result.categoryNotFoundNames.slice(0, 8).join(", ")}
                        {result.categoryNotFoundNames.length > 8
                          ? ` +${result.categoryNotFoundNames.length - 8} more`
                          : ""}
                      </span>
                    </p>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              Preview
              <Badge variant="secondary">{validCount} valid</Badge>
              {rows.filter((r) => r.status === "duplicate").length > 0 && (
                <Badge variant="outline">{rows.filter((r) => r.status === "duplicate").length} duplicate</Badge>
              )}
              {rows.filter((r) => r.status === "empty").length > 0 && (
                <Badge variant="outline">{rows.filter((r) => r.status === "empty").length} empty</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-md overflow-auto max-h-80">
              <table className="w-full">
                <thead className="sticky top-0 z-30 bg-muted/50">
                  <tr className="border-b">
                    <th className="text-left p-2 text-sm font-medium w-8">#</th>
                    <th className="text-left p-2 text-sm font-medium">Item Code</th>
                    <th className="text-left p-2 text-sm font-medium">Category</th>
                    <th className="text-left p-2 text-sm font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((row, i) => (
                    <tr key={i} className={`border-b last:border-b-0 ${row.status !== "ok" ? "opacity-50" : ""}`}>
                      <td className="p-2 text-sm text-muted-foreground">{i + 2}</td>
                      <td className="p-2 text-sm font-mono">
                        {row.itemCode || <span className="text-muted-foreground italic">empty</span>}
                      </td>
                      <td className="p-2 text-sm">
                        {row.categoryName || <span className="text-muted-foreground italic">empty</span>}
                      </td>
                      <td className="p-2">
                        {row.status === "ok" && <Badge className="bg-green-600 text-white border-0">Valid</Badge>}
                        {row.status === "duplicate" && <Badge variant="outline">Duplicate</Badge>}
                        {row.status === "empty" && <Badge variant="outline">Empty</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 200 && (
                <div className="p-2 text-center text-sm text-muted-foreground border-t">
                  Showing first 200 of {rows.length} rows
                </div>
              )}
            </div>

            <div className="flex gap-4 mt-4">
              <Button
                onClick={handleImport}
                disabled={isProcessing || validCount === 0 || !!result}
                data-testid="button-update-categories"
              >
                <Upload className="h-4 w-4 mr-2" />
                {isProcessing ? "Updating..." : `Update ${validCount} Item${validCount !== 1 ? "s" : ""}`}
              </Button>
              {result && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setRows([]);
                    setResult(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Upload Another File
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
