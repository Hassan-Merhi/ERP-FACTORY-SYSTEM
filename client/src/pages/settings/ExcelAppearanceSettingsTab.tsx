import { useEffect, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileSpreadsheet, ImagePlus, RotateCcw, Save, Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { fetchExcelAppearance } from "@/lib/excelAppearanceClient";
import {
  DEFAULT_EXCEL_APPEARANCE_SETTINGS,
  excelAppearanceSettingsSchema,
  type ExcelAppearanceSettings,
} from "@shared/universal-excel/appearanceSettings";

interface Props {
  company: { id: number; name: string } | null;
}

const MAX_LOGO_SIZE = 135_000;
const key = (id: number) => ["/api/excel-export/appearance", id];

export function ExcelAppearanceSettingsTab({ company }: Props) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<ExcelAppearanceSettings>({ ...DEFAULT_EXCEL_APPEARANCE_SETTINGS });
  const [previewing, setPreviewing] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: key(company?.id ?? 0),
    queryFn: fetchExcelAppearance,
    enabled: !!company?.id,
    staleTime: 0,
  });
  useEffect(() => {
    if (data?.appearance) setDraft(data.appearance);
  }, [data?.appearance, company?.id]);

  const save = useMutation({
    mutationFn: async (appearance: ExcelAppearanceSettings) => {
      const value = excelAppearanceSettingsSchema.parse(appearance);
      const response = await fetch("/api/excel-export/appearance", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || "Could not save company Excel settings");
      }
      return await response.json() as { appearance: ExcelAppearanceSettings };
    },
    onSuccess: (response) => {
      setDraft(response.appearance);
      void queryClient.invalidateQueries({ queryKey: ["/api/excel-export/appearance"] });
      toast({ title: "Excel appearance saved", description: "New exports will use this company's settings." });
    },
    onError: (reason: Error) => toast({
      title: "Could not save Excel appearance", description: reason.message, variant: "destructive",
    }),
  });

  const patch = <K extends keyof ExcelAppearanceSettings,>(field: K, value: ExcelAppearanceSettings[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const uploadLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > MAX_LOGO_SIZE) {
      toast({
        title: "Unsupported logo",
        description: "Choose a PNG or JPG smaller than 135 KB. SVG and remote image links are not supported.",
        variant: "destructive",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const candidate = { ...draft, logoDataUrl: reader.result };
        const parsed = excelAppearanceSettingsSchema.safeParse(candidate);
        if (parsed.success) patch("logoDataUrl", reader.result);
        else toast({ title: "Invalid logo", description: "Use a valid PNG or JPG image.", variant: "destructive" });
      }
    };
    reader.onerror = () => toast({ title: "Logo could not be read", variant: "destructive" });
    reader.readAsDataURL(file);
  };

  const downloadPreview = async () => {
    if (!company) return;
    try {
      const validated = excelAppearanceSettingsSchema.parse(draft);
      setPreviewing(true);
      const { downloadUniversalExcelWorkbook } = await import("@/lib/universalExcelExport");
      await downloadUniversalExcelWorkbook({
        schemaVersion: 1,
        title: "Excel Appearance Preview",
        mode: "report",
        appearance: validated,
        companyName: company.name,
        dateFormat: validated.dateFormat,
        currencyCode: "USD",
        sheets: [{
          kind: "table",
          name: "Sample Report",
          columns: [
            { key: "code", header: "Article Code", width: 18 },
            { key: "item", header: "Item", width: 28 },
            { key: "qty", header: "Qty", type: "integer", width: 12 },
            { key: "unit", header: "Price / Bale", type: "money", width: 18 },
            { key: "amount", header: "Total", type: "money", width: 16 },
          ],
          rows: [
            { code: "HMD10001", item: "Sample Bale", qty: 3, unit: 12.5, amount: 37.5 },
            { code: "HMD10002", item: "Sample Cotton", qty: 2, unit: 20, amount: 40 },
          ],
          footer: { code: "TOTAL", item: "", qty: 5, unit: null, amount: 77.5 },
        }],
      }, "dakzo-excel-appearance-preview.xlsx");
    } catch (reason: unknown) {
      toast({
        title: "Preview failed",
        description: reason instanceof Error ? reason.message : "Invalid appearance",
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  };

  if (!company) return <p className="text-sm text-muted-foreground">Select a company to manage Excel exports.</p>;
  if (isPending) return <p className="text-sm text-muted-foreground">Loading Excel appearance…</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">Could not load Excel settings: {error.message}</p>;

  const toggles: Array<{ key: keyof Pick<ExcelAppearanceSettings,
    "showBranding" | "alternateRows" | "printLayout" | "showCompanyName" | "showExportDate">; label: string }> = [
    { key: "showBranding", label: "Show Dakzo branding" },
    { key: "alternateRows", label: "Alternate report row colors" },
    { key: "printLayout", label: "Include printable headers and footers" },
    { key: "showCompanyName", label: "Show company name" },
    { key: "showExportDate", label: "Show export date" },
  ];

  return (
    <div className="space-y-5 max-w-4xl" data-testid="excel-appearance-settings">
      <div>
        <h2 className="text-xl font-semibold flex items-center gap-2"><FileSpreadsheet className="h-5 w-5" />Excel Export Appearance</h2>
        <p className="text-sm text-muted-foreground">Appearance for {company.name}. Applies to new report exports, not imported templates or historic files.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Brand and colors</CardTitle><CardDescription>Per-company styling for report title rows and Excel print layouts.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="excel-brand-name">Brand name</Label>
            <Input id="excel-brand-name" maxLength={70} value={draft.brandName} onChange={(e) => patch("brandName", e.target.value)} />
          </div>
          <div className="space-y-2"><Label htmlFor="excel-preset">Color preset</Label>
            <select id="excel-preset" className="w-full rounded-md border bg-background px-3 py-2" value={draft.preset}
              onChange={(e) => {
                const preset = e.target.value as ExcelAppearanceSettings["preset"];
                setDraft(current => ({ ...current, preset, accentColor: preset === "dakzo" ? "#183153" : "#334155" }));
              }}>
              <option value="dakzo">Dakzo Navy</option><option value="slate">Slate</option>
            </select>
          </div>
          <div className="space-y-2"><Label htmlFor="excel-accent">Accent color</Label>
            <div className="flex items-center gap-3">
              <input id="excel-accent" type="color" value={draft.accentColor}
                onChange={(e) => patch("accentColor", e.target.value)} className="h-10 w-14 rounded cursor-pointer" />
              <Input aria-label="Accent hex color" value={draft.accentColor} maxLength={7}
                onChange={(e) => patch("accentColor", e.target.value)} />
            </div>
          </div>
          <div className="space-y-2"><Label htmlFor="excel-logo">Logo image (PNG/JPG, 135 KB max)</Label>
            <Input id="excel-logo" type="file" accept="image/png,image/jpeg" onChange={uploadLogo} />
            {draft.logoDataUrl && <Button size="sm" variant="outline" onClick={() => patch("logoDataUrl", null)}>Remove logo</Button>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Headers and display</CardTitle><CardDescription>These choices never modify accounting values, import headers or formulas.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="excel-header">Print header text (optional)</Label>
              <Input id="excel-header" maxLength={90} value={draft.headerText} onChange={(e) => patch("headerText", e.target.value)} placeholder="Report title by default" />
            </div>
            <div className="space-y-2"><Label htmlFor="excel-footer">Print footer text (optional)</Label>
              <Input id="excel-footer" maxLength={90} value={draft.footerText} onChange={(e) => patch("footerText", e.target.value)} placeholder="Dakzo branding by default" />
            </div>
            <div className="space-y-2"><Label htmlFor="excel-date-format">Excel date format</Label>
              <select id="excel-date-format" className="w-full rounded-md border bg-background px-3 py-2" value={draft.dateFormat}
                onChange={(e) => patch("dateFormat", e.target.value as ExcelAppearanceSettings["dateFormat"])}>
                <option value="dd/mm/yyyy">DD/MM/YYYY</option><option value="mm/dd/yyyy">MM/DD/YYYY</option>
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {toggles.map((toggle) => (
              <div className="flex items-center justify-between rounded-md border p-3" key={toggle.key}>
                <Label htmlFor={"excel-" + toggle.key}>{toggle.label}</Label>
                <Switch id={"excel-" + toggle.key} checked={draft[toggle.key]} onCheckedChange={(v) => patch(toggle.key, v)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Live preview</CardTitle><CardDescription>Shows colors, logo, header text and table styling. The sample XLSX verifies Excel rendering.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border overflow-hidden text-sm">
            <div className="p-3 flex justify-between items-center gap-2" style={{ backgroundColor: draft.accentColor, color: "#fff" }}>
              <strong>Excel Appearance Preview</strong>
              {draft.showBranding && draft.logoDataUrl && <img src={draft.logoDataUrl} alt="Excel logo preview" className="max-h-10 max-w-32 object-contain" />}
            </div>
            <div className="px-3 py-2 text-muted-foreground">
              {draft.showCompanyName && <span>Company: {company.name} · </span>}
              {draft.showExportDate && <span>Date: {draft.dateFormat === "dd/mm/yyyy" ? "14/11/2026" : "11/14/2026"}</span>}
            </div>
            <div className="px-3 pb-2 font-semibold">{draft.showBranding ? draft.brandName : "Report"}</div>
            <div className="grid grid-cols-3 border-t px-3 py-2 font-semibold" style={{ backgroundColor: draft.accentColor, color: "#fff" }}>
              <span>Article Code</span><span>Qty</span><span>Total</span>
            </div>
            <div className="grid grid-cols-3 px-3 py-2" style={{ background: draft.alternateRows ? "#f4f7fb" : "transparent" }}>
              <span>HMD10001</span><span>3</span><span>$37.50</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate(draft)}><Save className="h-4 w-4 mr-2" />Save settings</Button>
            <Button variant="outline" onClick={() => setDraft({ ...DEFAULT_EXCEL_APPEARANCE_SETTINGS })}>
              <RotateCcw className="h-4 w-4 mr-2" />Restore default draft
            </Button>
            <Button variant="outline" disabled={previewing} onClick={() => void downloadPreview()}>
              <Download className="h-4 w-4 mr-2" />Download sample XLSX
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Sample preview does not save settings. Logos appear inside regular reports with at least five columns; strict templates and specialized invoices retain their own company-facing layout.</p>
        </CardContent>
      </Card>
    </div>
  );
}
