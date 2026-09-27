import { Upload, Package, FileText, FileImage, File, Trash2, Eye, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Skeleton } from "@/components/ui/skeleton";

import { fmt } from "./utils";
import type { useFactoryWorkerDetailModel } from "./useFactoryWorkerDetailModel";

interface FactoryWorkerDetailModelProps {
  model: ReturnType<typeof useFactoryWorkerDetailModel>;
}

export function FactoryWorkerDocumentsBalesPanel({ model }: FactoryWorkerDetailModelProps) {
  const {
    bales,
    balesLoading,
    deleteDocMutation,
    docInputRef,
    docsLoading,
    documents,
    endDate,
    formatDate,
    handleDocUpload,
    setEndDate,
    setPendingDeleteDocId,
    setStartDate,
    setViewingDoc,
    showBales,
    showDocuments,
    startDate,
    uploadingDoc,
  } = model;
  return (
    <>
      {showDocuments && (
        <TabsContent value="documents" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Worker Documents</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {documents?.length || 0} file{documents?.length !== 1 ? "s" : ""} uploaded
              </p>
            </div>
            <div>
              <input
                ref={docInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.xls"
                onChange={handleDocUpload}
                data-testid="input-doc-upload"
              />
              <Button
                variant="outline"
                onClick={() => docInputRef.current?.click()}
                disabled={uploadingDoc}
                data-testid="button-upload-doc"
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploadingDoc ? "Uploading..." : "Upload Document"}
              </Button>
            </div>
          </div>

          {docsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-md" />
              ))}
            </div>
          ) : !documents?.length ? (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground">
                <FileText className="mx-auto h-8 w-8 mb-3 opacity-30" />
                <p className="font-medium">No documents uploaded yet</p>
                <p className="text-sm mt-1">Upload contracts, IDs, permits, or any other files</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="divide-y">
                  {documents.map((doc) => {
                    const isImage = doc.fileType?.startsWith("image/");
                    const isPdf = doc.fileType === "application/pdf";
                    const Icon = isImage ? FileImage : isPdf ? FileText : File;
                    const sizeKb = doc.fileSize ? (doc.fileSize / 1024).toFixed(1) : null;
                    const uploadDate = doc.uploadedAt ? formatDate(doc.uploadedAt) : "—";
                    return (
                      <div key={doc.id} className="flex items-center gap-3 p-3" data-testid={`row-doc-${doc.id}`}>
                        <div className="shrink-0 text-muted-foreground">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" data-testid={`text-doc-name-${doc.id}`}>
                            {doc.originalName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {uploadDate}
                            {sizeKb ? ` · ${sizeKb} KB` : ""}
                          </p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (isImage) {
                                setViewingDoc(doc);
                              } else {
                                window.open(doc.fileUrl, "_blank");
                              }
                            }}
                            data-testid={`button-view-doc-${doc.id}`}
                          >
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            View
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              const a = document.createElement("a");
                              a.href = doc.fileUrl;
                              a.download = doc.originalName;
                              a.click();
                            }}
                            data-testid={`button-download-doc-${doc.id}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setPendingDeleteDocId(doc.id)}
                            disabled={deleteDocMutation.isPending}
                            data-testid={`button-delete-doc-${doc.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      )}

      {showBales && (
        <TabsContent value="bales">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-3.5 w-3.5" /> Bale History
                </CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="baleStart" className="text-xs text-muted-foreground">
                      From
                    </Label>
                    <Input
                      id="baleStart"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="w-auto"
                      data-testid="input-bale-start-date"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <Label htmlFor="baleEnd" className="text-xs text-muted-foreground">
                      To
                    </Label>
                    <Input
                      id="baleEnd"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-auto"
                      data-testid="input-bale-end-date"
                    />
                  </div>
                  {(startDate || endDate) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setStartDate("");
                        setEndDate("");
                      }}
                      data-testid="button-clear-bale-dates"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {balesLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : bales?.length ? (
                <div className="table-responsive">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Bale Code</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Weight KG</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bales.map((bale) => (
                        <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                          <TableCell className="font-medium text-sm" data-testid={`text-bale-code-${bale.id}`}>
                            {bale.baleCode}
                          </TableCell>
                          <TableCell className="text-sm">{bale.productName || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {parseFloat(bale.weightKg).toFixed(3)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(bale.totalCost)}</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                bale.status === "FINALIZED" || bale.status === "IN_STOCK" ? "default" : "secondary"
                              }
                              className="text-xs"
                            >
                              {bale.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm whitespace-nowrap">{formatDate(bale.finalizedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-10 text-muted-foreground">
                  <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">No bales found</p>
                  <p className="text-sm mt-1">No bale records{startDate || endDate ? " in selected range" : ""}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      )}
    </>
  );
}
