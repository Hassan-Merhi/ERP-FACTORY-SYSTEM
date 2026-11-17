import { PackageCheck, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { updatePropertiesContainerDestination } from "./propertiesDestinationSelections";
import { usePropertiesIntercompanyPOImportState } from "./usePropertiesIntercompanyPOImportState";
import { PropertiesIntercompanyPOImportCardSection } from "./PropertiesIntercompanyPOImportCardSection";
const currency = (amount: number | string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));

export default function PropertiesIntercompanyPOImport() {
  const {
    changeDefault,
    changeFile,
    companyId,
    copy,
    currentStockReview,
    defaultDestinationId,
    destinations,
    file,
    fileInputVersion,
    importDate,
    importMutation,
    navigate,
    outcome,
    preview,
    previewCompanyId,
    previewMutation,
    readyToPost,
    setDestinations,
    setImportDate,
    setPreview,
    setPreviewCompanyId,
    setSupplierId,
    setup,
    setupError,
    setupLoading,
    stockSignature,
    supplierId,
    verifyStockMutation,
  } = usePropertiesIntercompanyPOImportState();

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

      <PropertiesIntercompanyPOImportCardSection
        changeDefault={changeDefault}
        changeFile={changeFile}
        companyId={companyId}
        copy={copy}
        defaultDestinationId={defaultDestinationId}
        file={file}
        fileInputVersion={fileInputVersion}
        importDate={importDate}
        importMutation={importMutation}
        navigate={navigate}
        previewMutation={previewMutation}
        setImportDate={setImportDate}
        setSupplierId={setSupplierId}
        setup={setup}
        supplierId={supplierId}
      />

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
                        <TableCell>{currency(container.itemsTotal + container.chargesTotal)}</TableCell>
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
