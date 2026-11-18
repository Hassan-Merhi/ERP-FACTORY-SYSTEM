// Extracted from ./FactorySettingsAdminTools.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle, DollarSign, Loader2, Search } from "lucide-react";
import { useFactorySettingsAdminToolsState } from "./useFactorySettingsAdminToolsState";

export function FactorySettingsAdminToolsCardFixOcCurrency({
  ocFixMutation,
  ocFixResult,
  ocPreview,
  ocPreviewMutation,
}: Pick<
  ReturnType<typeof useFactorySettingsAdminToolsState>,
  "ocFixMutation" | "ocFixResult" | "ocPreview" | "ocPreviewMutation"
>) {
  return (
    <Card data-testid="card-fix-oc-currency">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-muted-foreground" />
          Fix Other Charges Currency
        </CardTitle>
        <CardDescription>
          If other charges were accidentally entered in EUR instead of USD, this tool re-posts their accounting entries
          in USD without reversing the offload. Click "Preview" first to see which containers are affected, then "Apply
          Fix".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            onClick={() => ocPreviewMutation.mutate()}
            disabled={ocPreviewMutation.isPending || ocFixMutation.isPending}
            data-testid="button-oc-currency-preview"
          >
            {ocPreviewMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Preview
          </Button>
          {ocPreview && ocPreview.length > 0 && (
            <Button
              onClick={() => ocFixMutation.mutate(ocPreview.map((container) => container.containerId))}
              disabled={ocFixMutation.isPending}
              data-testid="button-oc-currency-apply"
            >
              {ocFixMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <DollarSign className="h-4 w-4 mr-2" />
              )}
              Apply Fix — Re-post as USD ({ocPreview.length} container{ocPreview.length !== 1 ? "s" : ""})
            </Button>
          )}
        </div>

        {ocPreview && ocPreview.length > 0 && (
          <div className="space-y-2" data-testid="section-oc-preview">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 p-2 bg-amber-50 dark:bg-amber-950/30 rounded-md">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                Found <strong>{ocPreview.length}</strong> container{ocPreview.length !== 1 ? "s" : ""} with non-USD
                other charges. The existing EUR vouchers will be deleted and replaced with USD ones. The offload data is
                not affected.
              </span>
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-center">Current Currency</TableHead>
                    <TableHead className="text-center">Will Become</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ocPreview.flatMap((container) =>
                    container.charges.map((charge, chargeIndex) => (
                      <TableRow
                        key={`${container.containerId}-${chargeIndex}`}
                        data-testid={`row-oc-preview-${container.containerId}-${chargeIndex}`}
                      >
                        {chargeIndex === 0 && (
                          <TableCell rowSpan={container.charges.length} className="font-medium align-top">
                            {container.containerNumber}
                          </TableCell>
                        )}
                        <TableCell className="text-muted-foreground">{charge.description}</TableCell>
                        <TableCell className="text-right font-mono">
                          {parseFloat(charge.amount).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                            {charge.currencyCode}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                            USD
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {ocFixResult && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted text-sm" data-testid="text-oc-fix-result">
            <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
            <span>
              Done — {ocFixResult.fixed} container{ocFixResult.fixed !== 1 ? "s" : ""} re-posted in USD. The accounting
              ledger now shows USD for those other charges.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
