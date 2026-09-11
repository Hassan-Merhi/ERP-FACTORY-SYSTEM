import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Download, Upload } from "lucide-react";
import type { Company } from "@shared/schema";

type CompanyImportResult = {
  vouchers?: number;
  accounts?: number;
};

export function ExportImportSection({ companies }: { companies: Company[] }) {
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [selectedExport, setSelectedExport] = useState("");
  const [selectedImport, setSelectedImport] = useState("");
  const [importResult, setImportResult] = useState<CompanyImportResult | null>(null);

  const handleExport = async () => {
    if (!selectedExport) return;
    setIsExporting(true);
    try {
      const res = await fetch(`/api/companies/${selectedExport}/export`, { credentials: "include" });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `company_${selectedExport}_data.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      toast({ title: "Success", description: "Company data exported" });
    } catch (e) {
      toast({ title: "Export Error", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedImport) return;
    setIsImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/companies/${selectedImport}/import`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || "Import failed");
      setImportResult(result);
      toast({ title: "Success", description: "Company data imported" });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    } catch (e) {
      toast({ title: "Import Error", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setIsImporting(false);
      e.target.value = "";
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-4 border rounded-lg p-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Download className="h-4 w-4" /> Export Company Data
        </h3>
        <p className="text-sm text-muted-foreground">Download all accounting data for a company as JSON.</p>
        <div className="space-y-2">
          <Label>Select Company</Label>
          <Select value={selectedExport} onValueChange={setSelectedExport}>
            <SelectTrigger>
              <SelectValue placeholder="Pick company..." />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button className="w-full" onClick={handleExport} disabled={!selectedExport || isExporting}>
          {isExporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
          Export Data
        </Button>
      </div>

      <div className="space-y-4 border rounded-lg p-4">
        <h3 className="font-semibold flex items-center gap-2">
          <Upload className="h-4 w-4" /> Import Company Data
        </h3>
        <p className="text-sm text-muted-foreground">Upload accounting JSON to replace ALL data for this company.</p>
        <div className="space-y-2">
          <Label>Target Company</Label>
          <Select value={selectedImport} onValueChange={setSelectedImport}>
            <SelectTrigger>
              <SelectValue placeholder="Pick company..." />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative">
          <Input
            type="file"
            accept=".json"
            onChange={handleFileChange}
            disabled={!selectedImport || isImporting}
            className="cursor-pointer"
          />
          {isImporting && (
            <div className="absolute inset-0 bg-background/50 flex items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
        {importResult && (
          <div className="mt-2 p-2 bg-muted rounded text-xs">
            Imported: {importResult.vouchers} vouchers, {importResult.accounts} accounts.
          </div>
        )}
      </div>
    </div>
  );
}
