import { useEffect, useMemo, useState, useCallback } from "react";
import { Download, Languages, Pencil, Search, Upload } from "lucide-react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

interface FrenchCatalogRow {
  id: number;
  articleCode: string | null;
  nameEn: string;
  nameAr: string | null;
  nameFr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  descriptionFr: string | null;
  categoryId: number | null;
  categoryNameEn: string | null;
  categoryNameAr: string | null;
  categoryNameFr: string | null;
}

interface PreviewRow {
  rowNumber: number;
  articleCode: string;
  nameFr: string | null;
  categoryNameFr: string | null;
  descriptionFr: string | null;
  productId: number | null;
  categoryId: number | null;
  status: "ready" | "unknown";
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: "include", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
  return payload;
}

export function FactoryFrenchCatalogManager() {
  const { language } = useApplicationLanguage();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FrenchCatalogRow[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "missing" | "complete">("all");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<FrenchCatalogRow | null>(null);
  const [nameFr, setNameFr] = useState("");
  const [categoryNameFr, setCategoryNameFr] = useState("");
  const [descriptionFr, setDescriptionFr] = useState("");
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);

  const readyPreviewRows = useMemo(() => previewRows.filter((row) => row.status === "ready"), [previewRows]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, status });
      setRows(await jsonRequest(`/api/factory/french-catalog?${params}`));
    } catch (error) {
      toast({
        title: "Unable to load French translations",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [query, status, toast]);

  useEffect(() => {
    if (open) void loadRows();
  }, [loadRows, open, status]);

  const downloadTemplate = async () => {
    try {
      await downloadFromUrl("/api/factory/french-catalog/template", {
        fileName: exportFileName("french catalog template", "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const startEdit = (row: FrenchCatalogRow) => {
    setEditing(row);
    setNameFr(row.nameFr ?? "");
    setCategoryNameFr(row.categoryNameFr ?? "");
    setDescriptionFr(row.descriptionFr ?? "");
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await jsonRequest(`/api/factory/french-catalog/products/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nameFr, descriptionFr }),
      });
      if (editing.categoryId) {
        await jsonRequest(`/api/factory/french-catalog/categories/${editing.categoryId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nameFr: categoryNameFr }),
        });
      }
      toast({ title: "French translation saved" });
      setEditing(null);
      await loadRows();
    } catch (error) {
      toast({
        title: "Unable to save translation",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const previewWorkbook = async (file: File) => {
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/factory/french-catalog/import/preview", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Unable to preview workbook");
      setPreviewRows(payload.rows ?? []);
      toast({ title: "Workbook preview ready", description: `${payload.readyRows ?? 0} rows are ready to apply.` });
    } catch (error) {
      toast({
        title: "Workbook preview failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const applyWorkbook = async () => {
    try {
      const result = await jsonRequest("/api/factory/french-catalog/import/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: readyPreviewRows }),
      });
      toast({
        title: "French translations imported",
        description: `${result.updatedProducts} products and ${result.updatedCategories} categories updated.`,
      });
      setPreviewRows([]);
      await loadRows();
    } catch (error) {
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  if (language !== "fr") return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="mb-3">
          <Languages /> Gérer les traductions françaises
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Traductions françaises du catalogue</DialogTitle>
          <DialogDescription>
            Modifier, rechercher et importer les noms français sans changer les noms anglais, les codes, le stock ou les
            coûts.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <div className="flex min-w-64 flex-1 gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Rechercher code, anglais, arabe ou français"
              onKeyDown={(event) => event.key === "Enter" && void loadRows()}
            />
            <Button type="button" variant="outline" onClick={() => void loadRows()} isLoading={loading}>
              <Search /> Rechercher
            </Button>
          </div>
          <select
            className="rounded-md border bg-background px-3 text-sm"
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="all">Toutes</option>
            <option value="missing">Traduction manquante</option>
            <option value="complete">Traduction complète</option>
          </select>
          <Button type="button" variant="outline" onClick={() => void downloadTemplate()}>
            <Download /> Modèle Excel
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium">
            <Upload className="h-4 w-4" /> Importer Excel
            <input
              className="hidden"
              type="file"
              accept=".xlsx"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void previewWorkbook(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>

        {previewRows.length > 0 && (
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm">
                {readyPreviewRows.length} prêtes · {previewRows.length - readyPreviewRows.length} inconnues
              </span>
              <Button type="button" onClick={() => void applyWorkbook()} disabled={readyPreviewRows.length === 0}>
                Appliquer les lignes valides
              </Button>
            </div>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Anglais</TableHead>
              <TableHead>Français</TableHead>
              <TableHead>Catégorie FR</TableHead>
              <TableHead>État</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono">{row.articleCode}</TableCell>
                <TableCell>{row.nameEn}</TableCell>
                <TableCell>{row.nameFr || <span className="text-muted-foreground">Manquante</span>}</TableCell>
                <TableCell>{row.categoryNameFr || "—"}</TableCell>
                <TableCell>{row.nameFr ? "Complète" : "Manquante"}</TableCell>
                <TableCell>
                  <Button type="button" size="sm" variant="ghost" onClick={() => startEdit(row)}>
                    <Pencil /> Modifier
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Dialog open={Boolean(editing)} onOpenChange={(next) => !next && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Modifier la traduction française</DialogTitle>
              <DialogDescription>
                {editing?.articleCode} · {editing?.nameEn}
              </DialogDescription>
            </DialogHeader>
            <label className="space-y-1 text-sm">
              <span>Nom français</span>
              <Input value={nameFr} onChange={(event) => setNameFr(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span>Catégorie française</span>
              <Input value={categoryNameFr} onChange={(event) => setCategoryNameFr(event.target.value)} />
            </label>
            <label className="space-y-1 text-sm">
              <span>Description française</span>
              <Textarea value={descriptionFr} onChange={(event) => setDescriptionFr(event.target.value)} />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Annuler
              </Button>
              <Button type="button" onClick={() => void saveEdit()}>
                Enregistrer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
