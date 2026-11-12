import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { FileSpreadsheet, PackageCheck, ShieldCheck, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { propertiesPoImportText, PROPERTIES_PO_IMPORT_ERRORS } from "@/i18n/propertiesPoImportTranslations";
import {
  initializePropertiesDestinations,
  updatePropertiesDefaultDestination,
  updatePropertiesContainerCharges,
  updatePropertiesContainerDestination,
  validatePropertiesImportSelections,
  type PropertiesContainerDestinations,
} from "./propertiesDestinationSelections";

const API = "/api/intercompany-container-trading";
const currency = (amount: number | string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));

interface DestinationCompany {
  id: number;
  name: string;
  code: string;
}
interface PropertiesSupplier {
  id: number;
  companyId: number;
  legalName: string;
  code: string;
}
interface TradingSetup {
  sourceCompanyId: number;
  destinations: DestinationCompany[];
  suppliers: PropertiesSupplier[];
  policies: Array<{ id: number; destinationCompanyId: number; tradeEnabled: boolean }>;
}
interface ImportContainer {
  containerNumber: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: number;
  chargesTotal: number;
  grandTotal: number;
  supplierCode: string;
}
interface WorkbookPreview {
  fileName: string;
  sha256: string;
  rowCount: number;
  containers: ImportContainer[];
}
interface AutoRelationship {
  relationshipId: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
}
interface StockVerification {
  fileSha256: string;
  sourceCompanyId: number;
  verifiedRows: number;
  createdItemCount: number;
  reusedLineCount: number;
  rows: Array<{
    containerNumber: string;
    destinationCompanyId: number;
    excelRow: number;
    code: string;
    name: string;
    uom: string;
    sourceStockItemId: number;
    destinationStockItemId: number | null;
    action: "create" | "reuse";
  }>;
}
interface ImportOutcome {
  batchId: number;
  createdDestinationStockItems: number;
  containerCount: number;
  totalIntercompanyCost: string;
  containers: Array<{
    containerNumber: string;
    destinationCompanyId: number;
    destinationPoId: number;
    sourcePoIds: number[];
    landedTotal: string;
  }>;
}

async function postForm<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body, credentials: "include" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: PROPERTIES_PO_IMPORT_ERRORS.fileProcessing }));
    throw new Error(error.message || PROPERTIES_PO_IMPORT_ERRORS.fileProcessing);
  }
  return (await response.json()) as T;
}

export default function PropertiesIntercompanyPOImport() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const copy = propertiesPoImportText(useApplicationLanguageCode());
  const companyId = selectedCompany?.id ?? 0;
  const activeCompanyId = useRef(companyId);
  activeCompanyId.current = companyId;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [previewCompanyId, setPreviewCompanyId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [importDate, setImportDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [defaultDestinationId, setDefaultDestinationId] = useState("");
  const [destinations, setDestinations] = useState<PropertiesContainerDestinations>({});
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [stockReview, setStockReview] = useState<{ signature: string; data: StockVerification } | null>(null);
  const stockSignature = JSON.stringify({
    companyId,
    fileSha256: preview?.sha256 ?? "",
    destinations: Object.entries(destinations)
      .map(([containerNumber, selection]) => [containerNumber, selection.destinationCompanyId])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  });
  const activeStockSignature = useRef(stockSignature);
  activeStockSignature.current = stockSignature;
  const currentStockReview = stockReview?.signature === stockSignature ? stockReview.data : null;

  const {
    data: setup,
    isPending: setupLoading,
    error: setupError,
  } = useQuery<TradingSetup>({
    queryKey: companyQueryKey(`${API}/setup`, companyId),
    enabled: companyId > 0 && selectedCompany?.companyType === "properties",
    queryFn: async () => {
      const response = await fetch(`${API}/setup`, { credentials: "include" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: PROPERTIES_PO_IMPORT_ERRORS.setupUnavailable }));
        throw new Error(error.message || PROPERTIES_PO_IMPORT_ERRORS.setupUnavailable);
      }
      return (await response.json()) as TradingSetup;
    },
    staleTime: 0,
  });

  // A preview is never carried into a different company or restored from
  // session storage: the original bytes must accompany the verified import.
  useEffect(() => {
    setFile(null);
    setPreview(null);
    setPreviewCompanyId(null);
    setSupplierId("");
    setDefaultDestinationId("");
    setDestinations({});
    setOutcome(null);
    setStockReview(null);
  }, [companyId]);

  const previewMutation = useMutation({
    mutationFn: async ({ selectedFile }: { selectedFile: File; requestedCompanyId: number }) => {
      const body = new FormData();
      body.append("file", selectedFile);
      return postForm<WorkbookPreview>(`${API}/preview`, body);
    },
    onSuccess: (parsed, variables) => {
      if (variables.requestedCompanyId !== activeCompanyId.current) return;
      setPreview(parsed);
      setPreviewCompanyId(variables.requestedCompanyId);
      setDestinations(
        initializePropertiesDestinations(
          parsed.containers.map((container) => container.containerNumber),
          defaultDestinationId
        )
      );
      setOutcome(null);
      toast({ title: copy.parsed, description: [parsed.containers.length, copy.container.toLowerCase()].join(" ") });
    },
    onError: (error: Error) => toast({ title: copy.failure, description: error.message, variant: "destructive" }),
  });

  const verifyStockMutation = useMutation({
    mutationFn: async ({ requestedCompanyId, signature }: { requestedCompanyId: number; signature: string }) => {
      if (
        requestedCompanyId !== activeCompanyId.current ||
        !file ||
        !preview ||
        previewCompanyId !== requestedCompanyId ||
        !setup
      ) {
        throw new Error(copy.stale);
      }
      const verified = validatePropertiesImportSelections(
        preview.containers,
        destinations,
        new Set(setup.destinations.map((destination) => destination.id))
      );
      const body = new FormData();
      body.append("file", file);
      body.append(
        "selections",
        JSON.stringify(
          verified.map((row) => ({
            containerNumber: row.containerNumber,
            destinationCompanyId: row.destinationCompanyId,
          }))
        )
      );
      return {
        signature,
        requestedCompanyId,
        result: await postForm<StockVerification>(`${API}/stock-preview`, body),
      };
    },
    onSuccess: ({ signature, requestedCompanyId, result }) => {
      if (
        requestedCompanyId !== activeCompanyId.current ||
        preview?.sha256 !== result.fileSha256 ||
        signature !== activeStockSignature.current
      )
        return;
      setStockReview({ signature, data: result });
    },
    onError: (error: Error) => {
      setStockReview(null);
      toast({ title: copy.stockReviewFailed, description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (requestedCompanyId: number) => {
      if (requestedCompanyId !== activeCompanyId.current || !preview || previewCompanyId !== requestedCompanyId) {
        throw new Error(copy.stale);
      }
      if (!file) throw new Error(copy.noFile);
      if (
        !supplierId ||
        !setup?.suppliers.some(
          (supplier) => supplier.companyId === requestedCompanyId && supplier.id === Number(supplierId)
        )
      ) {
        throw new Error(copy.missingSupplier);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(importDate)) throw new Error(copy.importDate);
      const permitted = new Set(setup.destinations.map((destination) => destination.id));
      const validated = validatePropertiesImportSelections(preview.containers, destinations, permitted);
      const usedDestinations = [...new Set(validated.map((entry) => entry.destinationCompanyId))];
      const relationshipIds = new Map<number, number>();

      // Provision only the destinations the user selected. These transactions
      // create master data, never cash/stock/vouchers. The financial import
      // below remains one all-or-nothing multi-company PostgreSQL transaction.
      for (const destinationCompanyId of usedDestinations) {
        if (activeCompanyId.current !== requestedCompanyId) throw new Error(copy.stale);
        const response = await apiRequest("POST", `${API}/relationships/auto`, { destinationCompanyId });
        const result = (await response.json()) as AutoRelationship;
        if (!result.tradeEnabled || result.destinationCompanyId !== destinationCompanyId) {
          throw new Error(copy.setupFailed);
        }
        relationshipIds.set(destinationCompanyId, result.relationshipId);
      }
      if (activeCompanyId.current !== requestedCompanyId) throw new Error(copy.stale);
      const body = new FormData();
      body.append("file", file);
      body.append("externalSupplierId", supplierId);
      body.append("importDate", importDate);
      body.append(
        "selections",
        JSON.stringify(
          validated.map((entry) => ({
            containerNumber: entry.containerNumber,
            relationshipId: relationshipIds.get(entry.destinationCompanyId),
            chargesConfirmed: entry.chargesConfirmed,
            ...(entry.chargeEvidenceReference ? { chargeEvidenceReference: entry.chargeEvidenceReference } : {}),
          }))
        )
      );
      return { result: await postForm<ImportOutcome>(`${API}/import`, body), requestedCompanyId };
    },
    onSuccess: async ({ result, requestedCompanyId }) => {
      if (activeCompanyId.current !== requestedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/trades`, requestedCompanyId) });
        return;
      }
      setOutcome(result);
      setPreview(null);
      setFile(null);
      setFileInputVersion((version) => version + 1);
      setDestinations({});
      setStockReview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/setup`, companyId) }),
        queryClient.invalidateQueries({ queryKey: ["/api/containers"] }),
        queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/trades`, companyId) }),
      ]);
      toast({ title: copy.imported, description: copy.completeMessage });
    },
    onError: (error: Error) => toast({ title: copy.failure, description: error.message, variant: "destructive" }),
  });

  const changeFile = (next: File | null) => {
    setFile(next);
    setStockReview(null);
    setPreview(null);
    setPreviewCompanyId(null);
    setDestinations({});
    setOutcome(null);
  };
  const changeDefault = (next: string) => {
    setDefaultDestinationId(next);
    setDestinations((previous) => updatePropertiesDefaultDestination(previous, next));
  };

  const canPost =
    Boolean(file && preview && previewCompanyId === companyId && supplierId) &&
    Boolean(setup?.destinations.length) &&
    !importMutation.isPending &&
    !previewMutation.isPending &&
    !verifyStockMutation.isPending &&
    !setupLoading;
  const readyToPost = (() => {
    if (!canPost || !preview || !setup) return false;
    try {
      validatePropertiesImportSelections(
        preview.containers,
        destinations,
        new Set(setup.destinations.map((destination) => destination.id))
      );
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-10" data-testid="properties-po-import">
      <PageHeader title={copy.title} subtitle={copy.subtitle} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        {copy.sourceNote}
      </div>

      {setupError && (
        <p role="alert" className="text-destructive">
          {(setupError as Error).message}
        </p>
      )}
      {setupLoading && <p className="text-sm text-muted-foreground">{copy.parsing}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" /> {copy.uploadTitle}
          </CardTitle>
          <CardDescription>{copy.uploadDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1 space-y-2">
              <Label htmlFor="properties-po-file">{copy.chooseFile}</Label>
              <Input
                id="properties-po-file"
                key={`${companyId}:${fileInputVersion}`}
                type="file"
                accept=".xlsx"
                data-testid="input-file-upload"
                disabled={importMutation.isPending}
                onChange={(event) => changeFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <Button
              type="button"
              disabled={!file || previewMutation.isPending || importMutation.isPending || !setup?.destinations.length}
              onClick={() => file && previewMutation.mutate({ selectedFile: file, requestedCompanyId: companyId })}
              data-testid="button-parse"
            >
              <Upload className="mr-2 h-4 w-4" />
              {previewMutation.isPending ? copy.parsing : copy.parse}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate("/properties/suppliers")}>
              {copy.supplierLink}
            </Button>
          </div>
          {file && (
            <p className="text-xs text-muted-foreground">
              {copy.selected} {file.name}
            </p>
          )}
          {setup && setup.destinations.length === 0 && (
            <p role="alert" className="text-sm text-destructive">
              {copy.noDestinations}
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="properties-po-supplier">{copy.supplier}</Label>
              <select
                id="properties-po-supplier"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={supplierId}
                disabled={importMutation.isPending}
                onChange={(event) => setSupplierId(event.target.value)}
                data-testid="select-supplier"
              >
                <option value="">{copy.chooseSupplier}</option>
                {(setup?.suppliers ?? [])
                  .filter((supplier) => supplier.companyId === companyId)
                  .map((supplier) => (
                    <option value={supplier.id} key={supplier.id}>
                      {supplier.code} — {supplier.legalName}
                    </option>
                  ))}
              </select>
              {setup && !setup.suppliers.some((supplier) => supplier.companyId === companyId) && (
                <p className="text-xs text-destructive">{copy.noSuppliers}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="properties-po-date">{copy.importDate}</Label>
              <Input
                id="properties-po-date"
                type="date"
                value={importDate}
                disabled={importMutation.isPending}
                onChange={(event) => setImportDate(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="properties-po-default">{copy.defaultDestination}</Label>
              <select
                id="properties-po-default"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={defaultDestinationId}
                disabled={importMutation.isPending}
                onChange={(event) => changeDefault(event.target.value)}
                data-testid="select-default-erp-destination"
              >
                <option value="">{copy.chooseDestination}</option>
                {(setup?.destinations ?? []).map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.code} — {company.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{copy.destinationHelp}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {preview && previewCompanyId === companyId && (
        <Card data-testid="intercompany-po-preview">
          <CardHeader>
            <CardTitle>{copy.previewTitle}</CardTitle>
            <CardDescription>
              {copy.previewDescription} {preview.containers.length} {copy.container.toLowerCase()}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.container}</TableHead>
                    <TableHead>{copy.details}</TableHead>
                    <TableHead>{copy.total}</TableHead>
                    <TableHead>{copy.charges}</TableHead>
                    <TableHead>{copy.landed}</TableHead>
                    <TableHead>{copy.destination}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.containers.map((container) => {
                    const selected = destinations[container.containerNumber];
                    return (
                      <TableRow
                        key={container.containerNumber}
                        data-testid={`po-container-${container.containerNumber}`}
                      >
                        <TableCell className="font-medium">
                          {container.containerNumber}
                          {container.supplierCode && (
                            <div className="text-xs text-muted-foreground">
                              {copy.code}: {container.supplierCode}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {container.itemsCount} / {container.posCount}
                        </TableCell>
                        <TableCell>{currency(container.itemsTotal)}</TableCell>
                        <TableCell>{currency(container.chargesTotal)}</TableCell>
                        <TableCell>
                          {currency(container.itemsTotal + (selected?.chargesConfirmed ? container.chargesTotal : 0))}
                        </TableCell>
                        <TableCell className="min-w-[220px] space-y-2">
                          <select
                            aria-label={`${copy.destination}: ${container.containerNumber}`}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={selected?.overridden ? selected.destinationCompanyId : "__default"}
                            disabled={importMutation.isPending}
                            data-testid={`select-destination-${container.containerNumber}`}
                            onChange={(event) =>
                              setDestinations((current) =>
                                updatePropertiesContainerDestination(
                                  current,
                                  container.containerNumber,
                                  event.target.value === "__default" ? null : event.target.value,
                                  defaultDestinationId
                                )
                              )
                            }
                          >
                            <option value="__default">
                              {copy.followDefault}{" "}
                              {defaultDestinationId
                                ? `(${setup?.destinations.find((company) => String(company.id) === defaultDestinationId)?.name ?? ""})`
                                : ""}
                            </option>
                            {(setup?.destinations ?? []).map((company) => (
                              <option key={company.id} value={company.id}>
                                {company.name}
                              </option>
                            ))}
                          </select>
                          <Label className="flex items-center gap-2 text-xs">
                            <Checkbox
                              checked={Boolean(selected?.chargesConfirmed)}
                              disabled={importMutation.isPending}
                              onCheckedChange={(checked) =>
                                setDestinations((current) =>
                                  updatePropertiesContainerCharges(current, container.containerNumber, {
                                    chargesConfirmed: checked === true,
                                  })
                                )
                              }
                            />
                            {copy.confirmCharges}
                          </Label>
                          {selected?.chargesConfirmed && container.chargesTotal !== 0 && (
                            <Input
                              aria-label={`${copy.evidence}: ${container.containerNumber}`}
                              placeholder={copy.evidencePlaceholder}
                              value={selected.chargeEvidenceReference}
                              disabled={importMutation.isPending}
                              onChange={(event) =>
                                setDestinations((current) =>
                                  updatePropertiesContainerCharges(current, container.containerNumber, {
                                    chargeEvidenceReference: event.target.value,
                                  })
                                )
                              }
                            />
                          )}
                          {!selected?.chargesConfirmed && container.chargesTotal !== 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-300">{copy.chargeWarning}</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-3 rounded-md border p-3" data-testid="properties-po-stock-review">
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!readyToPost || verifyStockMutation.isPending}
                  onClick={() =>
                    verifyStockMutation.mutate({ requestedCompanyId: companyId, signature: stockSignature })
                  }
                  data-testid="button-verify-destination-stock"
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {verifyStockMutation.isPending ? copy.verifyingStock : copy.verifyStock}
                </Button>
                {currentStockReview && (
                  <div className="text-sm" data-testid="stock-review-counts">
                    {copy.stockCreatedCount}: <strong>{currentStockReview.createdItemCount}</strong> ·{" "}
                    {copy.stockReusedCount}: <strong>{currentStockReview.reusedLineCount}</strong>
                  </div>
                )}
              </div>
              {currentStockReview && (
                <>
                  <p className="text-xs text-muted-foreground">{copy.stockReviewDetails}</p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{copy.container}</TableHead>
                          <TableHead>{copy.destination}</TableHead>
                          <TableHead>{copy.code}</TableHead>
                          <TableHead>{copy.stockAction}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {currentStockReview.rows.slice(0, 30).map((row) => (
                          <TableRow key={`${row.containerNumber}:${row.excelRow}`}>
                            <TableCell>{row.containerNumber}</TableCell>
                            <TableCell>
                              {setup?.destinations.find((company) => company.id === row.destinationCompanyId)?.name ??
                                row.destinationCompanyId}
                            </TableCell>
                            <TableCell>
                              {row.code} — {row.name} ({row.uom})
                            </TableCell>
                            <TableCell>{row.action === "create" ? copy.stockCreate : copy.stockReuse}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {currentStockReview.rows.length > 30 && (
                    <p className="text-xs text-muted-foreground">{copy.stockReviewMore}</p>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                variant="outline"
                disabled={importMutation.isPending}
                onClick={() => {
                  setPreview(null);
                  setDestinations({});
                  setPreviewCompanyId(null);
                }}
              >
                {copy.clear}
              </Button>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">{copy.ready}</p>
                <Button
                  type="button"
                  data-testid="button-import"
                  disabled={!readyToPost}
                  onClick={() => importMutation.mutate(companyId)}
                >
                  <PackageCheck className="mr-2 h-4 w-4" />
                  {importMutation.isPending ? copy.confirming : copy.confirm}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {copy.readyExplanation} {copy.rerunBlocked}
            </p>
          </CardContent>
        </Card>
      )}

      {outcome && (
        <Card data-testid="intercompany-po-import-result">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PackageCheck className="h-5 w-5" /> {copy.posted}
            </CardTitle>
            <CardDescription>
              {copy.batch}: {outcome.batchId} · {copy.linked}: {outcome.containerCount} ·{" "}
              {currency(outcome.totalIntercompanyCost)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm" data-testid="imported-stock-item-count">
              {copy.importedStockCount}: <strong>{outcome.createdDestinationStockItems ?? 0}</strong>
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.container}</TableHead>
                  <TableHead>{copy.destination}</TableHead>
                  <TableHead>{copy.destinationPo}</TableHead>
                  <TableHead>{copy.landed}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcome.containers.map((row) => (
                  <TableRow key={row.containerNumber}>
                    <TableCell>{row.containerNumber}</TableCell>
                    <TableCell>
                      {setup?.destinations.find((company) => company.id === row.destinationCompanyId)?.name ??
                        row.destinationCompanyId}
                    </TableCell>
                    <TableCell>{row.destinationPoId}</TableCell>
                    <TableCell>{currency(row.landedTotal)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate("/properties/containers")}>{copy.openContainers}</Button>
              <Button variant="outline" onClick={() => navigate("/properties/tracking")}>
                {copy.openTracking}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
