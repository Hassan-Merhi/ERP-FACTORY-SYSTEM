import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Filter, Loader2, Package } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function FactorySupplierReport() {
  const { toast } = useToast();
  const today = new Date().toLocaleDateString("en-CA");
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA");

  const [companyId, setCompanyId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [supplierId, setSupplierId] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState(false);

  interface CompanyOption {
    id: number;
    name: string;
  }

  const { data: companies = [] } = useQuery<CompanyOption[]>({
    queryKey: ["/api/user/companies"],
  });

  useEffect(() => {
    if (companies.length === 1 && companyId === null) {
      setCompanyId(companies[0].id);
    }
  }, [companies, companyId]);

  const { data: suppliers = [], isLoading: suppliersLoading } = useQuery<CompanyOption[]>({
    queryKey: ["/api/factory/suppliers", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch suppliers");
      return res.json();
    },
    enabled: !!companyId,
  });

  const handleExport = async (format: "pdf" | "excel") => {
    if (!companyId) {
      toast({ title: "Please select a company", variant: "destructive" });
      return;
    }
    if (!startDate || !endDate) {
      toast({ title: "Please select a date range", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    try {
      const res = await fetch("/api/factory/reports/supplier-usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          companyId,
          supplierId: supplierId ? Number(supplierId) : undefined,
          startDate,
          endDate,
          format,
        }),
      });
      if (!res.ok) throw new Error("Failed to generate report");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `supplier-report-${startDate}-${endDate}.${format === "pdf" ? "pdf" : "xlsx"}`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Report generated successfully" });
    } catch (error) {
      toast({ title: "Export failed", description: getErrorDetails(error).message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <PageHeader title="Supplier Usage Report" subtitle="Generate supplier-level usage and cost reports" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Report Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 flex-wrap">
            {companies.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Company</Label>
                <Select
                  value={companyId ? String(companyId) : ""}
                  onValueChange={(val) => {
                    setCompanyId(Number(val));
                    setSupplierId("");
                  }}
                >
                  <SelectTrigger className="w-48" data-testid="select-company">
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
                data-testid="input-start-date"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
                data-testid="input-end-date"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Supplier</Label>
              <Select
                value={supplierId || "all"}
                onValueChange={(val) => setSupplierId(val === "all" ? "" : val)}
                disabled={!companyId || suppliersLoading}
              >
                <SelectTrigger className="w-48" data-testid="select-supplier">
                  <SelectValue placeholder="All Suppliers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Suppliers</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => handleExport("pdf")}
                disabled={isGenerating || !companyId}
                data-testid="button-export-pdf"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                Export PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => handleExport("excel")}
                disabled={isGenerating || !companyId}
                data-testid="button-export-excel"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Export Excel
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Package className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">What this report includes</p>
              <p className="text-sm text-muted-foreground mt-1">
                This report includes supplier-level KG balances, cost analysis, bale production data, and mixing
                breakdowns for the selected date range.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Recent Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mt-3" data-testid="text-reports-on-demand">
              Reports are generated on demand. Use the filters above to generate a new report.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
